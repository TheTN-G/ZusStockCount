import { createHash, randomBytes } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { and, desc, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  AddStoreMemberBody,
  AddStoreMemberResponse,
  CreateStoreInvitationBody,
  CreateStoreInvitationResponse,
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
} from "@workspace/api-zod";
import {
  db,
  passwordResetTokensTable,
  storeInvitationsTable,
  securityEventsTable,
  storeUsersTable,
  storeroomMembershipsTable,
} from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";

const router: IRouter = Router();
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

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

function signupRedirectUrl(req: Request) {
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) return undefined;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.host !== host) return undefined;
    return new URL("/sign-up", parsedOrigin.origin).toString();
  } catch {
    return undefined;
  }
}

router.get("/users", requireRoles("owner", "admin", "supervisor"), async (req, res): Promise<void> => {
  const users = await db
    .select({
      id: storeUsersTable.id,
      name: storeUsersTable.name,
      email: storeUsersTable.email,
      role: storeroomMembershipsTable.role,
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
      users.map((user) => ({ ...user, storeName: req.storeroom!.name })),
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
        createdAt: securityEventsTable.createdAt,
      })
      .from(securityEventsTable)
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
    const email = body.data.email.trim().toLowerCase();
    const [user] = await db
      .select()
      .from(storeUsersTable)
      .where(sql`lower(${storeUsersTable.email}) = ${email}`)
      .limit(1);
    if (!user) {
      res.status(404).json({
        error: "No registered account was found with that email. Ask them to sign up first.",
      });
      return;
    }

    const [membership] = await db
      .insert(storeroomMembershipsTable)
      .values({
        storeroomId: req.storeroomId!,
        userId: user.id,
        role: body.data.role,
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
        email: user.email,
        role: body.data.role,
        storeName: req.storeroom!.name,
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
  async (req, res): Promise<void> => {
    const body = CreateStoreInvitationBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const inviteeName = body.data.name.trim();
    if (!inviteeName) {
      res.status(400).json({ error: "Invitee name cannot be blank." });
      return;
    }
    if (
      req.storeMembership!.role === "supervisor" &&
      body.data.role !== "staff"
    ) {
      res.status(403).json({
        error: "Managers can invite team members as staff only.",
      });
      return;
    }

    const email = body.data.email.trim().toLowerCase();
    const [existingUser] = await db
      .select({ userId: storeUsersTable.id })
      .from(storeUsersTable)
      .where(sql`lower(${storeUsersTable.email}) = ${email}`)
      .limit(1);
    if (existingUser) {
      res.status(409).json({
        error: "An account already exists with that email. Add them as an existing team member instead.",
      });
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
    let invitation: typeof storeInvitationsTable.$inferSelect | undefined;
    try {
      invitation = await db.transaction(async (tx) => {
        await tx
          .update(storeInvitationsTable)
          .set({ status: "expired" })
          .where(
            and(
              eq(storeInvitationsTable.storeroomId, req.storeroomId!),
              eq(storeInvitationsTable.email, email),
              eq(storeInvitationsTable.status, "pending"),
              lte(storeInvitationsTable.expiresAt, now),
            ),
          );

        const [pending] = await tx
          .select({ id: storeInvitationsTable.id })
          .from(storeInvitationsTable)
          .where(
            and(
              eq(storeInvitationsTable.storeroomId, req.storeroomId!),
              eq(storeInvitationsTable.email, email),
              eq(storeInvitationsTable.status, "pending"),
              gt(storeInvitationsTable.expiresAt, now),
            ),
          )
          .limit(1);
        if (pending) return undefined;

        const [created] = await tx
          .insert(storeInvitationsTable)
          .values({
            storeroomId: req.storeroomId!,
            email,
            role: body.data.role,
            createdByUserId: req.storeUser!.id,
            expiresAt,
          })
          .returning();
        return created;
      });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === "23505") {
        res.status(409).json({ error: "An invitation is already pending for that email." });
        return;
      }
      throw error;
    }
    if (!invitation) {
      res.status(409).json({ error: "An invitation is already pending for that email." });
      return;
    }

    let createdClerkInvitationId: string | undefined;
    try {
      const redirectUrl = signupRedirectUrl(req);
      const clerkInvitation = await clerkClient.invitations.createInvitation({
        emailAddress: email,
        expiresInDays: 7,
        publicMetadata: {
          storeInvitationId: String(invitation.id),
          inviteeName,
        },
        ...(redirectUrl ? { redirectUrl } : {}),
      });
      createdClerkInvitationId = clerkInvitation.id;
      const [updated] = await db
        .update(storeInvitationsTable)
        .set({ clerkInvitationId: clerkInvitation.id })
        .where(
          and(
            eq(storeInvitationsTable.id, invitation.id),
            eq(storeInvitationsTable.storeroomId, req.storeroomId!),
            eq(storeInvitationsTable.status, "pending"),
          ),
        )
        .returning();
      if (!updated) {
        await clerkClient.invitations.revokeInvitation(clerkInvitation.id);
        res.status(409).json({ error: "This invitation is no longer active." });
        return;
      }
      res
        .status(201)
        .json(CreateStoreInvitationResponse.parse(invitationResponse(updated)));
    } catch (error) {
      if (createdClerkInvitationId) {
        try {
          await clerkClient.invitations.revokeInvitation(
            createdClerkInvitationId,
          );
        } catch (revokeError) {
          req.log.error(
            { err: revokeError },
            "Could not roll back Clerk invitation after a send failure",
          );
        }
      }
      try {
        await db
          .update(storeInvitationsTable)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(
            and(
              eq(storeInvitationsTable.id, invitation.id),
              eq(storeInvitationsTable.status, "pending"),
            ),
          );
      } catch (updateError) {
        req.log.error(
          { err: updateError },
          "Could not mark failed storeroom invitation inactive",
        );
      }
      req.log.error({ err: error }, "Could not send storeroom invitation");
      res.status(502).json({
        error: "Could not send the invitation email. Please check the address and try again.",
      });
    }
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
      .set({ role: body.data.role })
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
        email: storeUsersTable.email,
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
        email: user.email,
        role: membership.role,
        storeName: req.storeroom!.name,
      }),
    );
  },
);

export default router;
