import { clerkClient, getAuth } from "@clerk/express";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import {
  db,
  productsTable,
  purchaseOrdersTable,
  stockCountsTable,
  storeInvitationsTable,
  storeUsersTable,
  workspacesTable,
  storeroomMembershipsTable,
  storeroomsTable,
  type StoreUserRecord,
  type StoreroomMembershipRecord,
  type StoreroomRecord,
} from "@workspace/db";
import { findLocalSession } from "../auth/localAuth";
import {
  accessDenialForRequest,
  staffMayAccessRequest,
} from "../lib/storeAccess";

type StoreTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type StoreAuthContext = {
  userId: string | null;
  sessionClaims?: unknown;
  authType?: "local" | "clerk";
  sessionId?: string;
};

export type StoreAuthResolver = (
  req: Request,
) => StoreAuthContext | Promise<StoreAuthContext>;

declare global {
  namespace Express {
    interface Request {
      storeUser?: StoreUserRecord;
      storeMembership?: StoreroomMembershipRecord;
      storeroom?: StoreroomRecord;
      storeroomId?: number;
      workspaceId?: number;
      storeAuthType?: "local" | "clerk";
      storeAuthSessionId?: string;
    }
  }
}

function claimString(
  claims: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function membershipRoleForLegacyUser(
  user: StoreUserRecord,
  ownerId: string,
): string {
  if (user.id === ownerId) return "owner";
  if (["admin", "supervisor", "staff"].includes(user.role)) return user.role;
  return "staff";
}

async function ensureWorkspaceAssociations(user: StoreUserRecord): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72410633)`);
    const memberships = await tx
      .select({
        membership: storeroomMembershipsTable,
        storeroom: storeroomsTable,
      })
      .from(storeroomMembershipsTable)
      .innerJoin(
        storeroomsTable,
        eq(storeroomsTable.id, storeroomMembershipsTable.storeroomId),
      )
      .where(eq(storeroomMembershipsTable.userId, user.id));

    for (const { membership, storeroom } of memberships) {
      const [ownerMembership] = await tx
        .select({ userId: storeroomMembershipsTable.userId })
        .from(storeroomMembershipsTable)
        .where(
          and(
            eq(storeroomMembershipsTable.storeroomId, storeroom.id),
            eq(storeroomMembershipsTable.role, "owner"),
          ),
        )
        .orderBy(asc(storeroomMembershipsTable.createdAt))
        .limit(1);
      const ownerUserId =
        storeroom.ownerUserId ?? ownerMembership?.userId ?? user.id;
      if (!storeroom.ownerUserId) {
        await tx
          .update(storeroomsTable)
          .set({ ownerUserId })
          .where(eq(storeroomsTable.id, storeroom.id));
      }

      let [workspace] = await tx
        .select()
        .from(workspacesTable)
        .where(eq(workspacesTable.ownerUserId, ownerUserId))
        .limit(1);
      if (!workspace) {
        const [owner] = await tx
          .select()
          .from(storeUsersTable)
          .where(eq(storeUsersTable.id, ownerUserId))
          .limit(1);
        [workspace] = await tx
          .insert(workspacesTable)
          .values({
            name: `${owner?.name.trim() || "My"} Workspace`.slice(0, 80),
            ownerUserId,
          })
          .returning();
      }

      await tx
        .update(storeroomsTable)
        .set({ workspaceId: workspace.id })
        .where(
          and(
            eq(storeroomsTable.ownerUserId, ownerUserId),
            isNull(storeroomsTable.workspaceId),
          ),
        );
      if (storeroom.workspaceId === null) {
        await tx
          .update(storeroomsTable)
          .set({ workspaceId: workspace.id })
          .where(eq(storeroomsTable.id, storeroom.id));
      }
      if (membership.role === "owner" && ownerUserId !== user.id) {
        await tx
          .update(storeroomMembershipsTable)
          .set({ role: membershipRoleForLegacyUser(user, ownerUserId) })
          .where(eq(storeroomMembershipsTable.id, membership.id));
      }
    }
  });
}

async function ensureStoreroomMembershipInTransaction(
  tx: StoreTransaction,
  user: StoreUserRecord,
  isNewAccount: boolean,
): Promise<void> {
  const [currentMembership] = await tx
    .select({ id: storeroomMembershipsTable.id })
    .from(storeroomMembershipsTable)
    .where(eq(storeroomMembershipsTable.userId, user.id))
    .limit(1);
  if (currentMembership) return;

  const [firstStoreroom] = await tx
    .select()
    .from(storeroomsTable)
    .orderBy(asc(storeroomsTable.id))
    .limit(1);

  if (!firstStoreroom) {
    // Existing single-store records are claimed once by the first signed-in user.
    // This is data-only backfill; schema changes are handled by the database publish flow.
    const users = await tx
      .select()
      .from(storeUsersTable)
      .orderBy(asc(storeUsersTable.createdAt), asc(storeUsersTable.id));
    const legacyUsers = isNewAccount
      ? users.filter((candidate) => candidate.id !== user.id)
      : users;
    const owner =
      legacyUsers.find((candidate) => candidate.role === "admin") ??
      legacyUsers[0] ??
      user;
    let [workspace] = await tx
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerUserId, owner.id))
      .limit(1);
    if (!workspace) {
      [workspace] = await tx
        .insert(workspacesTable)
        .values({
          name: `${owner.name.trim() || "My"} Workspace`.slice(0, 80),
          ownerUserId: owner.id,
          setupComplete: !(isNewAccount && owner.id === user.id),
        })
        .returning();
    }
    const [room] = await tx
      .insert(storeroomsTable)
      .values({
        workspaceId: workspace.id,
        name: "Main Outlet",
        ownerUserId: owner.id,
      })
      .returning();

    await tx
      .update(productsTable)
      .set({ storeroomId: room.id })
      .where(isNull(productsTable.storeroomId));
    await tx
      .update(purchaseOrdersTable)
      .set({ storeroomId: room.id })
      .where(isNull(purchaseOrdersTable.storeroomId));
    await tx
      .update(stockCountsTable)
      .set({ storeroomId: room.id })
      .where(isNull(stockCountsTable.storeroomId));

    if (legacyUsers.length > 0) {
      await tx.insert(storeroomMembershipsTable).values(
        legacyUsers.map((member) => ({
          storeroomId: room.id,
          userId: member.id,
          role: membershipRoleForLegacyUser(member, owner.id),
        })),
      );
    } else {
      await tx.insert(storeroomMembershipsTable).values({
        storeroomId: room.id,
        userId: user.id,
        role: "owner",
      });
    }
    if (legacyUsers.length > 0 && isNewAccount) {
      let [personalWorkspace] = await tx
        .select()
        .from(workspacesTable)
        .where(eq(workspacesTable.ownerUserId, user.id))
        .limit(1);
      if (!personalWorkspace) {
        [personalWorkspace] = await tx
          .insert(workspacesTable)
          .values({
            name: `${user.name.trim() || "My"} Workspace`.slice(0, 80),
            ownerUserId: user.id,
            setupComplete: false,
          })
          .returning();
      }
      const [personalRoom] = await tx
        .insert(storeroomsTable)
        .values({
          workspaceId: personalWorkspace.id,
          name: "Main Outlet",
          ownerUserId: user.id,
        })
        .returning();
      await tx.insert(storeroomMembershipsTable).values({
        storeroomId: personalRoom.id,
        userId: user.id,
        role: "owner",
      });
    }
    return;
  }

  // Claim an unowned default room when one exists; otherwise give a new account
  // its own isolated room rather than exposing another owner's inventory.
  const [unownedRoom] = await tx
    .select()
    .from(storeroomsTable)
    .where(isNull(storeroomsTable.ownerUserId))
    .orderBy(asc(storeroomsTable.id))
    .limit(1);
  if (unownedRoom) {
    const [roomMember] = await tx
      .select({ id: storeroomMembershipsTable.id })
      .from(storeroomMembershipsTable)
      .where(eq(storeroomMembershipsTable.storeroomId, unownedRoom.id))
      .limit(1);
    if (!roomMember) {
      let [workspace] = await tx
        .select()
        .from(workspacesTable)
        .where(eq(workspacesTable.ownerUserId, user.id))
        .limit(1);
      if (!workspace) {
        [workspace] = await tx
          .insert(workspacesTable)
          .values({
            name: `${user.name.trim() || "My"} Workspace`.slice(0, 80),
            ownerUserId: user.id,
            setupComplete: !isNewAccount,
          })
          .returning();
      }
      await tx
        .update(storeroomsTable)
        .set({ ownerUserId: user.id, workspaceId: workspace.id, name: "Main Outlet" })
        .where(eq(storeroomsTable.id, unownedRoom.id));
      await tx.insert(storeroomMembershipsTable).values({
        storeroomId: unownedRoom.id,
        userId: user.id,
        role: "owner",
      });
      return;
    }
  }

  let [workspace] = await tx
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.ownerUserId, user.id))
    .limit(1);
  if (!workspace) {
    [workspace] = await tx
      .insert(workspacesTable)
      .values({
        name: `${user.name.trim() || "My"} Workspace`.slice(0, 80),
        ownerUserId: user.id,
        setupComplete: !isNewAccount,
      })
      .returning();
  }
  const [room] = await tx
    .insert(storeroomsTable)
    .values({
      workspaceId: workspace.id,
      name: "Main Outlet",
      ownerUserId: user.id,
    })
    .returning();
  await tx.insert(storeroomMembershipsTable).values({
    storeroomId: room.id,
    userId: user.id,
    role: "owner",
  });
}

async function ensureStoreroomMembership(
  user: StoreUserRecord,
  isNewAccount: boolean,
): Promise<void> {
  const [currentMembership] = await db
    .select({ id: storeroomMembershipsTable.id })
    .from(storeroomMembershipsTable)
    .where(eq(storeroomMembershipsTable.userId, user.id))
    .limit(1);
  if (currentMembership) return;

  await db.transaction(async (tx) => {
    // Serialize onboarding and the one-time migration of existing single-store data.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72410632)`);
    await ensureStoreroomMembershipInTransaction(tx, user, isNewAccount);
  });
}

async function ensureStoreUser(
  userId: string,
  claims: Record<string, unknown>,
  fetchClerkProfile: boolean,
): Promise<StoreUserRecord> {
  const isLocalIdentity = claims.authType === "local";
  const email = claimString(claims, ["email", "email_address"]) ?? "";
  const claimedName = claimString(claims, ["name", "full_name"]);
  const splitName = [
    claimString(claims, ["first_name"]),
    claimString(claims, ["last_name"]),
  ]
    .filter(Boolean)
    .join(" ");
  const name =
    claimedName ||
    splitName ||
    (email ? email.split("@")[0] : "Store team member");

  const [existing] = await db
    .select()
    .from(storeUsersTable)
    .where(eq(storeUsersTable.id, userId))
    .limit(1);

  if (existing) {
    let profile = existing;
    if (
      !isLocalIdentity &&
      ((email && email !== existing.email) || name !== existing.name)
    ) {
      const [updated] = await db
        .update(storeUsersTable)
        .set({ name, email: email || existing.email })
        .where(eq(storeUsersTable.id, userId))
        .returning();
      profile = updated;
    }
    await ensureStoreroomMembership(profile, false);
    await ensureWorkspaceAssociations(profile);
    return profile;
  }

  const clerkUser = fetchClerkProfile
    ? await clerkClient.users.getUser(userId)
    : undefined;
  const primaryEmailAddress = clerkUser?.primaryEmailAddress;
  const clerkEmail =
    primaryEmailAddress?.emailAddress.trim().toLowerCase() ??
    claimString(claims, ["email", "email_address"])?.toLowerCase() ??
    "";
  const isEmailVerified =
    primaryEmailAddress?.verification?.status === "verified";
  const clerkName = [clerkUser?.firstName, clerkUser?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const inviteeNameValue = clerkUser?.publicMetadata?.inviteeName;
  const inviteeName =
    typeof inviteeNameValue === "string" ? inviteeNameValue.trim() : "";
  const clerkAccountName =
    claimedName ||
    splitName ||
    clerkName ||
    inviteeName ||
    (clerkEmail ? clerkEmail.split("@")[0] : "Store team member");
  const invitationIdValue = clerkUser?.publicMetadata?.storeInvitationId;
  const invitationId =
    typeof invitationIdValue === "number" ||
    (typeof invitationIdValue === "string" && /^\d+$/.test(invitationIdValue))
      ? Number(invitationIdValue)
      : null;

  const result = await db.transaction(async (tx) => {
    // Retain the legacy global role for compatibility; store permissions now live
    // on each storeroom membership.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72410631)`);
    // Keep new-account creation and initial room assignment inside the same
    // serialized onboarding window as legacy-data backfill.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(72410632)`);
    const [afterLock] = await tx
      .select()
      .from(storeUsersTable)
      .where(eq(storeUsersTable.id, userId))
      .limit(1);
    if (afterLock) return { user: afterLock, joinedInvitation: false };

    const [countResult] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(storeUsersTable);
    const role = countResult.count === 0 ? "admin" : "staff";
    const [created] = await tx
      .insert(storeUsersTable)
      .values({ id: userId, name: clerkAccountName, email: clerkEmail, role })
      .returning();
    if (
      !isEmailVerified ||
      !invitationId ||
      !Number.isSafeInteger(invitationId)
    ) {
      await ensureStoreroomMembershipInTransaction(tx, created, true);
      return { user: created, joinedInvitation: false };
    }

    const [invitation] = await tx
      .select({
        id: storeInvitationsTable.id,
        storeroomId: storeInvitationsTable.storeroomId,
        role: storeInvitationsTable.role,
      })
      .from(storeInvitationsTable)
      .where(
        and(
          eq(storeInvitationsTable.id, invitationId),
          eq(storeInvitationsTable.email, clerkEmail),
          eq(storeInvitationsTable.status, "pending"),
          gt(storeInvitationsTable.expiresAt, new Date()),
        ),
      )
      .for("update")
      .limit(1);
    if (!invitation) {
      await ensureStoreroomMembershipInTransaction(tx, created, true);
      return { user: created, joinedInvitation: false };
    }

    const [acceptedInvitation] = await tx
      .update(storeInvitationsTable)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(
        and(
          eq(storeInvitationsTable.id, invitation.id),
          eq(storeInvitationsTable.status, "pending"),
          gt(storeInvitationsTable.expiresAt, new Date()),
        ),
      )
      .returning({ id: storeInvitationsTable.id });
    if (!acceptedInvitation) {
      await ensureStoreroomMembershipInTransaction(tx, created, true);
      return { user: created, joinedInvitation: false };
    }

    await tx
      .insert(storeroomMembershipsTable)
      .values({
        storeroomId: invitation.storeroomId,
        userId: created.id,
        role: invitation.role,
      })
      .onConflictDoNothing();
    return { user: created, joinedInvitation: true };
  });
  if (!result.joinedInvitation) {
    await ensureStoreroomMembership(result.user, true);
  }
  await ensureWorkspaceAssociations(result.user);
  return result.user;
}

export function createRequireStoreUser(
  resolveAuth?: StoreAuthResolver,
) {
  return async function requireStoreUser(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const auth = resolveAuth
      ? await resolveAuth(req)
      : await resolveRequestAuth(req);
    if (!auth.userId) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }

    try {
      const claims = (auth.sessionClaims ?? {}) as Record<string, unknown>;
      const user = await ensureStoreUser(
        auth.userId,
        claims,
        resolveAuth === undefined,
      );
      if (auth.authType === "clerk" && user.passwordHash) {
        res.status(403).json({
          error: "This account now uses username and password sign-in. Use the standard sign-in page.",
          code: "PASSWORD_SIGN_IN_REQUIRED",
        });
        return;
      }
      const memberships = await db
        .select({
          membership: storeroomMembershipsTable,
          storeroom: storeroomsTable,
        })
        .from(storeroomMembershipsTable)
        .innerJoin(
          storeroomsTable,
          eq(storeroomsTable.id, storeroomMembershipsTable.storeroomId),
        )
        .where(eq(storeroomMembershipsTable.userId, user.id))
        .orderBy(
          asc(storeroomMembershipsTable.createdAt),
          asc(storeroomMembershipsTable.id),
        );

      const requestedId = Number(
        req.get("x-outlet-id") ?? req.get("x-storeroom-id"),
      );
      const selected =
        (Number.isSafeInteger(requestedId) && requestedId > 0
          ? memberships.find(({ storeroom }) => storeroom.id === requestedId)
          : undefined) ?? memberships[0];
      if (!selected) {
        res
          .status(403)
          .json({ error: "No storeroom access is configured for this account." });
        return;
      }
      const workspaceId = selected.storeroom.workspaceId;
      if (!workspaceId) {
        res.status(409).json({
          error: "Workspace setup is incomplete. Reload to finish setup.",
        });
        return;
      }

      req.storeUser = user;
      req.storeAuthType = auth.authType ?? "clerk";
      req.storeAuthSessionId = auth.sessionId;
      req.storeMembership = selected.membership;
      req.storeroom = selected.storeroom;
      req.storeroomId = selected.storeroom.id;
      req.workspaceId = workspaceId;
      if (
        user.mustChangePassword &&
        !(
          (req.method === "GET" && req.path === "/me") ||
          (req.method === "PATCH" && req.path === "/users/me/password")
        )
      ) {
        res.status(403).json({
          error: "Change your temporary password before continuing.",
          code: "PASSWORD_CHANGE_REQUIRED",
        });
        return;
      }
      const accessDenied = accessDenialForRequest(
        selected.membership.role,
        selected.membership.permissions,
        req.path,
        req.method,
      );
      if (accessDenied) {
        res.status(403).json({ error: accessDenied });
        return;
      }
      res.setHeader("X-Active-Outlet-Id", String(selected.storeroom.id));
      res.setHeader("X-Active-Storeroom-Id", String(selected.storeroom.id));
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function resolveRequestAuth(req: Request): Promise<StoreAuthContext> {
  const session = await findLocalSession(req);
  if (session) {
    return {
      userId: session.userId,
      authType: "local",
      sessionId: session.id,
      sessionClaims: { authType: "local" },
    };
  }
  const clerk = getAuth(req);
  return {
    userId: clerk.userId ?? null,
    sessionClaims: clerk.sessionClaims,
    authType: "clerk",
  };
}

export const requireStoreUser = createRequireStoreUser();

export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.storeUser || !req.storeMembership) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    if (
      !roles.includes(req.storeMembership.role) &&
      !staffMayAccessRequest(
        req.path,
        req.method,
        req.storeMembership.permissions,
      )
    ) {
      res
        .status(403)
        .json({ error: "You do not have permission for this action." });
      return;
    }
    next();
  };
}
