import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  ChangeMyPasswordBody,
  MigrateLegacyAccountBody,
  UpdateMyProfileBody,
} from "@workspace/api-zod";
import { authSessionsTable, db, storeUsersTable } from "@workspace/db";
import {
  createLocalSession,
  hashPassword,
  normalizeUsername,
  requireSameOrigin,
  setLocalSessionCookie,
  verifyPassword,
} from "../auth/localAuth";
import { getCurrentUserData } from "./currentUser";

const router: IRouter = Router();

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

router.post("/auth/migrate", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req, res)) return;
  const body = MigrateLegacyAccountBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter a valid username and password." });
    return;
  }
  if (req.storeAuthType !== "clerk") {
    res.status(409).json({ error: "This account already uses password sign-in." });
    return;
  }
  if (req.storeUser!.passwordHash) {
    res.status(409).json({ error: "Username and password are already set." });
    return;
  }

  const username = normalizeUsername(body.data.username);
  const [existingUsername] = await db
    .select({ id: storeUsersTable.id })
    .from(storeUsersTable)
    .where(
      and(
        sql`lower(${storeUsersTable.username}) = ${username}`,
        sql`${storeUsersTable.id} <> ${req.storeUser!.id}`,
      ),
    )
    .limit(1);
  if (existingUsername) {
    res.status(409).json({ error: "That username is already in use." });
    return;
  }
  try {
    const [updated] = await db
      .update(storeUsersTable)
      .set({
        username,
        passwordHash: await hashPassword(body.data.password),
        mustChangePassword: false,
      })
      .where(eq(storeUsersTable.id, req.storeUser!.id))
      .returning();
    req.storeUser = updated;
    const token = await createLocalSession(updated.id);
    setLocalSessionCookie(req, res, token);
    res.setHeader("Cache-Control", "no-store");
    res.json(await getCurrentUserData(req));
  } catch (error) {
    if (uniqueViolation(error)) {
      res.status(409).json({ error: "That username is already in use." });
      return;
    }
    throw error;
  }
});

router.patch("/users/me/profile", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req, res)) return;
  const body = UpdateMyProfileBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter a valid name, username, and email." });
    return;
  }
  const name = body.data.name.trim();
  const username = normalizeUsername(body.data.username);
  const email = body.data.email?.trim().toLowerCase() ?? "";
  if (!name) {
    res.status(400).json({ error: "Name cannot be blank." });
    return;
  }
  const [existingUsername] = await db
    .select({ id: storeUsersTable.id })
    .from(storeUsersTable)
    .where(
      and(
        sql`lower(${storeUsersTable.username}) = ${username}`,
        sql`${storeUsersTable.id} <> ${req.storeUser!.id}`,
      ),
    )
    .limit(1);
  if (existingUsername) {
    res.status(409).json({ error: "That username is already in use." });
    return;
  }
  if (email) {
    const [existingEmail] = await db
      .select({ id: storeUsersTable.id })
      .from(storeUsersTable)
      .where(
        and(
          sql`lower(${storeUsersTable.email}) = ${email}`,
          sql`${storeUsersTable.id} <> ${req.storeUser!.id}`,
        ),
      )
      .limit(1);
    if (existingEmail) {
      res.status(409).json({ error: "That email is already linked to an account." });
      return;
    }
  }

  try {
    const [updated] = await db
      .update(storeUsersTable)
      .set({ name, username, email })
      .where(eq(storeUsersTable.id, req.storeUser!.id))
      .returning();
    req.storeUser = updated;
    res.json(await getCurrentUserData(req));
  } catch (error) {
    if (uniqueViolation(error)) {
      res.status(409).json({ error: "That username is already in use." });
      return;
    }
    throw error;
  }
});

router.patch("/users/me/password", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req, res)) return;
  const body = ChangeMyPasswordBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter a new password with at least 8 characters." });
    return;
  }
  const currentUser = req.storeUser!;
  if (!currentUser.passwordHash) {
    res.status(409).json({
      error: "Add username and password sign-in from your account security settings first.",
    });
    return;
  }
  if (
    !currentUser.mustChangePassword &&
    !body.data.currentPassword
  ) {
    res.status(400).json({ error: "Enter your current password." });
    return;
  }
  if (
    body.data.currentPassword &&
    !(await verifyPassword(body.data.currentPassword, currentUser.passwordHash))
  ) {
    res.status(400).json({ error: "Current password is incorrect." });
    return;
  }

  const newHash = await hashPassword(body.data.newPassword);
  const changedAt = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(storeUsersTable)
      .set({ passwordHash: newHash, mustChangePassword: false })
      .where(eq(storeUsersTable.id, currentUser.id));
    const conditions = [
      eq(authSessionsTable.userId, currentUser.id),
      sql`${authSessionsTable.revokedAt} IS NULL`,
    ];
    if (req.storeAuthSessionId) {
      conditions.push(sql`${authSessionsTable.id} <> ${req.storeAuthSessionId}`);
    }
    await tx
      .update(authSessionsTable)
      .set({ revokedAt: changedAt })
      .where(and(...conditions));
  });
  res.json({ complete: true });
});

export default router;
