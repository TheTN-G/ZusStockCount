import { createHash, randomBytes } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { and, desc, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  AddStoreMemberBody,
  AddStoreMemberResponse,
  ListStoreUsersResponse,
  ListStoreInvitationsResponse,
  ListStoreSecurityEventsResponse,
  RequestStoreUserPasswordResetParams,
  RequestStoreUserPasswordResetResponse,
  RevokeStoreInvitationParams,
  RevokeStoreInvitationResponse,
  UpdateStoreUserRoleBody,
  UpdateStoreUserRoleParams,
  UpdateStoreUserRoleResponse,
  UpdateStoreUserAccessBody,
  UpdateStoreUserAccessParams,
  UpdateStoreUserAccessResponse,
} from "@workspace/api-zod";
import {
  db,
  passwordResetTokensTable,
  storeInvitationsTable,
  securityEventsTable,
  storeUsersTable,
  storeroomMembershipsTable,
  storeroomsTable,
} from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";
import { effectiveStoreAccess } from "../lib/storeAccess";

const router: IRouter = Router();
function invitationResponse(
  invitation: typeof storeInvitationsTable.$inferSelect,
  now = new Date(),
) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    status:
      invitation.status === "pending" && invitation.expiresAt <= now
        ? "expired"
        : invitation.status,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
  };
}

router.get("/users", requireRoles("owner", "admin", "supervisor"), async (req, res): Promise<void> => {
  const users = await db
    .select({
      id: storeUsersTable.id,
      name: storeUsersTable.name,
      username: storeUsersTable.username,
      email: storeUsersTable.email,
      role: storeroomMembershipsTable.role,
      permissions: storeroomMembershipsTable.permissions,
      mustChangePassword: storeUsersTable.mustChangePassword,
    })
    .from(storeroomMembershipsTable)
    .innerJoin(
      storeUsersTable,
      eq(storeUsersTable.id, storeroomMembershipsTable.userId),
    )
    .where(eq(storeroomMembershipsTable.storeroomId, req.storeroomId!))
    .orderBy(storeUsersTable.createdAt);
  res.json(
    ListStoreUsersResponse.parse(
      users.map((user) => ({
        ...user,
        storeName: req.storeroom!.name,
        access: effectiveStoreAccess(user.role, user.permissions),
      })),
    ),
  );
});

router.get(
  "/users/security-events",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const events = await db
      .select({
        id: securityEventsTable.id,
        eventType: securityEventsTable.eventType,
        actorName: securityEventsTable.actorName,
        targetName: securityEventsTable.targetName,
        actorUserId: securityEventsTable.actorUserId,
        targetUserId: securityEventsTable.targetUserId,
        storeroomId: securityEventsTable.storeroomId,
        outletName: storeroomsTable.name,
        changedSections: securityEventsTable.changedSections,
        createdAt: securityEventsTable.createdAt,
      })
      .from(securityEventsTable)
      .innerJoin(
        storeroomsTable,
        eq(storeroomsTable.id, securityEventsTable.storeroomId),
      )
      .where(eq(securityEventsTable.storeroomId, req.storeroomId!))
      .orderBy(desc(securityEventsTable.createdAt))
      .limit(100);
    res.json(ListStoreSecurityEventsResponse.parse(events));
  },
);

router.post(
  "/users/:userId/password-reset",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = RequestStoreUserPasswordResetParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [target] = await db
      .select({
        userId: storeroomMembershipsTable.userId,
        role: storeroomMembershipsTable.role,
        name: storeUsersTable.name,
      })
      .from(storeroomMembershipsTable)
      .innerJoin(
        storeUsersTable,
        eq(storeUsersTable.id, storeroomMembershipsTable.userId),
      )
      .where(
        and(
          eq(storeroomMembershipsTable.userId, params.data.userId),
          eq(storeroomMembershipsTable.storeroomId, req.storeroomId!),
        ),
      )
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Team member not found in this outlet." });
      return;
    }
    if (target.userId === req.storeUser!.id || target.role === "owner") {
      res.status(403).json({
        error: "You cannot start password recovery for this account.",
      });
      return;
    }
    if (
      req.storeMembership!.role === "supervisor" &&
      target.role !== "staff"
    ) {
      res.status(403).json({
        error: "Managers can start password recovery for staff only.",
      });
      return;
    }

    const resetToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(resetToken).digest("hex");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 30 * 60 * 1000);

    await db.transaction(async (tx) => {
      await tx
        .update(passwordResetTokensTable)
        .set({ usedAt: createdAt })
        .where(
          and(
            eq(passwordResetTokensTable.storeroomId, req.storeroomId!),
            eq(passwordResetTokensTable.targetUserId, target.userId),
            isNull(passwordResetTokensTable.usedAt),
          ),
        );
      await tx.insert(passwordResetTokensTable).values({
        storeroomId: req.storeroomId!,
        targetUserId: target.userId,
        actorUserId: req.storeUser!.id,
        tokenHash,
        createdAt,
        expiresAt,
      });
      await tx.insert(securityEventsTable).values({
        storeroomId: req.storeroomId!,
        actorUserId: req.storeUser!.id,
        targetUserId: target.userId,
        actorName: req.storeUser!.name,
        targetName: target.name,
        eventType: "password_reset_link_created",
        changedSections: [],
      });
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(
      RequestStoreUserPasswordResetResponse.parse({
        resetToken,
        expiresAt,
      }),
    );
  },
);

router.post(
  "/users",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const body = AddStoreMemberBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (
      req.storeMembership!.role === "supervisor" &&
      body.data.role !== "staff"
    ) {
      res.status(403).json({
        error: "Managers can add team members as staff only.",
      });
      return;
    }
    const email = body.data.email?.trim().toLowerCase() ?? "";
    const username = body.data.username?.trim().toLowerCase() ?? "";
    const identifier = username || email;
    if (!identifier) {
      res.status(400).json({ error: "Enter a username or registered email address." });
      return;
    }
    const [user] = await db
      .select()
      .from(storeUsersTable)
      .where(
        identifier.includes("@")
          ? sql`lower(${storeUsersTable.email}) = ${identifier}`
          : sql`lower(${storeUsersTable.username}) = ${identifier}`,
      )
      .limit(1);
    if (!user) {
      res.status(404).json({
        error: "No account matched that username or email.",
      });
      return;
    }

    const [membership] = await db
      .insert(storeroomMembershipsTable)
      .values({
        storeroomId: req.storeroomId!,
        userId: user.id,
        role: body.data.role,
        permissions:
          body.data.role === "staff"
            ? effectiveStoreAccess("staff", body.data.access)
            : null,
      })
      .onConflictDoNothing()
      .returning({ id: storeroomMembershipsTable.id });
    if (!membership) {
      res.status(409).json({ error: "That person is already on this storeroom team." });
      return;
    }

    res.status(201).json(
      AddStoreMemberResponse.parse({
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: body.data.role,
        storeName: req.storeroom!.name,
        mustChangePassword: user.mustChangePassword,
        access: effectiveStoreAccess(
          body.data.role,
          body.data.role === "staff" ? body.data.access : null,
        ),
      }),
    );
  },
);

router.get(
  "/users/invitations",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const roomFilter = eq(storeInvitationsTable.storeroomId, req.storeroomId!);
    const invitations = await db
      .select()
      .from(storeInvitationsTable)
      .where(
        req.storeMembership!.role === "supervisor"
          ? and(roomFilter, eq(storeInvitationsTable.role, "staff"))
          : roomFilter,
      )
      .orderBy(desc(storeInvitationsTable.createdAt));
    res.json(
      ListStoreInvitationsResponse.parse(
        invitations.map((invitation) => invitationResponse(invitation)),
      ),
    );
  },
);

router.post(
  "/users/invitations",
  requireRoles("owner", "admin", "supervisor"),
  async (_req, res): Promise<void> => {
    res.status(410).json({
      error: "Email invitations are disabled. Create a username and temporary password instead.",
    });
  },
);

router.delete(
  "/users/invitations/:invitationId",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = RevokeStoreInvitationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [invitation] = await db
      .select()
      .from(storeInvitationsTable)
      .where(
        and(
          eq(storeInvitationsTable.id, params.data.invitationId),
          eq(storeInvitationsTable.storeroomId, req.storeroomId!),
        ),
      )
      .limit(1);
    if (!invitation) {
      res.status(404).json({ error: "Invitation not found for this storeroom." });
      return;
    }
    if (
      req.storeMembership!.role === "supervisor" &&
      invitation.role !== "staff"
    ) {
      res.status(403).json({
        error: "Managers can revoke staff invitations only.",
      });
      return;
    }
    if (invitation.status === "accepted") {
      res.status(409).json({ error: "An accepted invitation cannot be revoked." });
      return;
    }
    if (invitation.status === "revoked") {
      res.json(RevokeStoreInvitationResponse.parse(invitationResponse(invitation)));
      return;
    }
    if (invitation.expiresAt <= new Date()) {
      const [expired] = await db
        .update(storeInvitationsTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(storeInvitationsTable.id, invitation.id),
            eq(storeInvitationsTable.storeroomId, req.storeroomId!),
            eq(storeInvitationsTable.status, "pending"),
          ),
        )
        .returning();
      res.json(
        RevokeStoreInvitationResponse.parse(
          invitationResponse(expired ?? { ...invitation, status: "expired" }),
        ),
      );
      return;
    }

    const [revoked] = await db
      .update(storeInvitationsTable)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(
        and(
          eq(storeInvitationsTable.id, invitation.id),
          eq(storeInvitationsTable.storeroomId, req.storeroomId!),
          eq(storeInvitationsTable.status, "pending"),
        ),
      )
      .returning();
    if (!revoked) {
      res.status(409).json({ error: "This invitation is no longer pending." });
      return;
    }

    if (revoked.clerkInvitationId) {
      try {
        await clerkClient.invitations.revokeInvitation(
          revoked.clerkInvitationId,
        );
      } catch (error) {
        req.log.error({ err: error }, "Could not revoke Clerk invitation");
        res.status(502).json({
          error: "The invitation was blocked in this storeroom, but its email link could not be disabled.",
        });
        return;
      }
    }
    res.json(
      RevokeStoreInvitationResponse.parse(invitationResponse(revoked)),
    );
  },
);

router.patch(
  "/users/:userId/role",
  requireRoles("owner", "admin"),
  async (req, res): Promise<void> => {
    const params = UpdateStoreUserRoleParams.safeParse(req.params);
    const body = UpdateStoreUserRoleBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const [membership] = await db
      .update(storeroomMembershipsTable)
      .set({ role: body.data.role, permissions: null })
      .where(
        and(
          eq(storeroomMembershipsTable.userId, params.data.userId),
          eq(storeroomMembershipsTable.storeroomId, req.storeroomId!),
          ne(storeroomMembershipsTable.role, "owner"),
        ),
      )
      .returning({
        userId: storeroomMembershipsTable.userId,
        role: storeroomMembershipsTable.role,
      });
    if (!membership) {
      const [target] = await db
        .select({ role: storeroomMembershipsTable.role })
        .from(storeroomMembershipsTable)
        .where(
          and(
            eq(storeroomMembershipsTable.userId, params.data.userId),
            eq(storeroomMembershipsTable.storeroomId, req.storeroomId!),
          ),
        )
        .limit(1);
      res.status(target ? 409 : 404).json({
        error: target
          ? "The storeroom owner role cannot be changed."
          : "Store user not found.",
      });
      return;
    }
    const [user] = await db
      .select({
        id: storeUsersTable.id,
        name: storeUsersTable.name,
        username: storeUsersTable.username,
        email: storeUsersTable.email,
        mustChangePassword: storeUsersTable.mustChangePassword,
      })
      .from(storeUsersTable)
      .where(eq(storeUsersTable.id, membership.userId))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: "Store user not found." });
      return;
    }
    res.json(
      UpdateStoreUserRoleResponse.parse({
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: membership.role,
        storeName: req.storeroom!.name,
        mustChangePassword: user.mustChangePassword,
        access: effectiveStoreAccess(membership.role, null),
      }),
    );
  },
);

router.patch(
  "/users/:userId/access",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = UpdateStoreUserAccessParams.safeParse(req.params);
    const body = UpdateStoreUserAccessBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [membership] = await tx
        .select({
          role: storeroomMembershipsTable.role,
          permissions: storeroomMembershipsTable.permissions,
        })
        .from(storeroomMembershipsTable)
        .where(
          and(
            eq(storeroomMembershipsTable.userId, params.data.userId),
            eq(storeroomMembershipsTable.storeroomId, req.storeroomId!),
          ),
        )
        .for("update");
      if (!membership) return { kind: "missing" as const };
      if (membership.role !== "staff") return { kind: "not_staff" as const };

      const [user] = await tx
        .select({
          id: storeUsersTable.id,
          name: storeUsersTable.name,
          username: storeUsersTable.username,
          email: storeUsersTable.email,
          mustChangePassword: storeUsersTable.mustChangePassword,
        })
        .from(storeUsersTable)
        .where(eq(storeUsersTable.id, params.data.userId));
      if (!user) return { kind: "missing" as const };

      const previousAccess = effectiveStoreAccess("staff", membership.permissions);
      const changedSections = Object.entries(body.data.access)
        .flatMap(([section, newAccess]) => {
          const previous = previousAccess[section as keyof typeof previousAccess];
          return previous === newAccess
            ? []
            : [{ section, previousAccess: previous, newAccess }];
        });
      const [updated] = await tx
        .update(storeroomMembershipsTable)
        .set({ permissions: body.data.access })
        .where(
          and(
            eq(storeroomMembershipsTable.userId, params.data.userId),
            eq(storeroomMembershipsTable.storeroomId, req.storeroomId!),
            eq(storeroomMembershipsTable.role, "staff"),
          ),
        )
        .returning({ role: storeroomMembershipsTable.role });
      if (updated && changedSections.length > 0) {
        await tx.insert(securityEventsTable).values({
          storeroomId: req.storeroomId!,
          actorUserId: req.storeUser!.id,
          targetUserId: user.id,
          actorName: req.storeUser!.name,
          targetName: user.name,
          eventType: "staff_access_updated",
          changedSections,
        });
      }
      if (!updated) return { kind: "missing" as const };
      return { kind: "updated" as const, updated, user };
    });
    if (result.kind === "missing") {
      res.status(404).json({ error: "Team member not found in this outlet." });
      return;
    }
    if (result.kind === "not_staff") {
      res.status(400).json({ error: "Custom section access is available for staff accounts." });
      return;
    }
    res.json(
      UpdateStoreUserAccessResponse.parse({
        ...result.user,
        role: result.updated.role,
        storeName: req.storeroom!.name,
        access: effectiveStoreAccess("staff", body.data.access),
      }),
    );
  },
);

export default router;
