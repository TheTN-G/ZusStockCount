import { createHash, randomBytes, randomUUID } from "node:crypto";
import { or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  RegisterAccountBody,
  SignInWithPasswordBody,
  SignOutAccountBody,
} from "@workspace/api-zod";
import {
  db,
  storeroomMembershipsTable,
  storeroomsTable,
  storeUsersTable,
  workspacesTable,
} from "@workspace/db";
import {
  clearLocalSessionCookie,
  createLocalSession,
  hashPassword,
  normalizeUsername,
  requireSameOrigin,
  revokeRequestSession,
  setLocalSessionCookie,
  verifyPassword,
} from "../auth/localAuth";

const router: IRouter = Router();
const failedAttempts = new Map<string, { count: number; since: number }>();
const dummyHashPromise = hashPassword(randomBytes(32).toString("hex"));
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_IDENTIFIER_ATTEMPTS = 8;
const MAX_IP_ATTEMPTS = 30;

function isRateLimited(key: string, maximum: number): boolean {
  const now = Date.now();
  if (failedAttempts.size > 5_000) {
    for (const [entry, attempt] of failedAttempts) {
      if (now - attempt.since > ATTEMPT_WINDOW_MS) failedAttempts.delete(entry);
    }
  }
  const current = failedAttempts.get(key);
  if (!current || now - current.since > ATTEMPT_WINDOW_MS) {
    failedAttempts.set(key, { count: 0, since: now });
    return false;
  }
  return current.count >= maximum;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const current = failedAttempts.get(key);
  if (!current || now - current.since > ATTEMPT_WINDOW_MS) {
    failedAttempts.set(key, { count: 1, since: now });
  } else {
    current.count += 1;
  }
}

function clearFailures(...keys: string[]): void {
  keys.forEach((key) => failedAttempts.delete(key));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

router.post("/auth/register", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req, res)) return;
  const body = RegisterAccountBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter valid workspace and account details." });
    return;
  }
  const name = body.data.name.trim();
  const workspaceName = body.data.workspaceName.trim();
  const username = normalizeUsername(body.data.username);
  const email = body.data.email?.trim().toLowerCase() ?? "";
  if (!name || !workspaceName) {
    res.status(400).json({ error: "Name and business name cannot be blank." });
    return;
  }
  if (email.length > 320) {
    res.status(400).json({ error: "Email address is too long." });
    return;
  }

  const userId = `local_${randomUUID()}`;
  const passwordHash = await hashPassword(body.data.password);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(72410631)`);
      const [duplicateUsername] = await tx
        .select({ id: storeUsersTable.id })
        .from(storeUsersTable)
        .where(sql`lower(${storeUsersTable.username}) = ${username}`)
        .limit(1);
      if (duplicateUsername) throw new Error("USERNAME_TAKEN");
      if (email) {
        const [duplicateEmail] = await tx
          .select({ id: storeUsersTable.id })
          .from(storeUsersTable)
          .where(sql`lower(${storeUsersTable.email}) = ${email}`)
          .limit(1);
        if (duplicateEmail) throw new Error("EMAIL_TAKEN");
      }

      await tx.insert(storeUsersTable).values({
        id: userId,
        name,
        username,
        email,
        role: "admin",
        passwordHash,
        mustChangePassword: false,
      });
      const [workspace] = await tx
        .insert(workspacesTable)
        .values({
          name: workspaceName,
          ownerUserId: userId,
          setupComplete: false,
        })
        .returning({ id: workspacesTable.id });
      const [storeroom] = await tx
        .insert(storeroomsTable)
        .values({
          workspaceId: workspace.id,
          name: "Main Outlet",
          ownerUserId: userId,
        })
        .returning({ id: storeroomsTable.id });
      await tx.insert(storeroomMembershipsTable).values({
        storeroomId: storeroom.id,
        userId,
        role: "owner",
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "USERNAME_TAKEN") {
      res.status(409).json({ error: "That username is already in use." });
      return;
    }
    if (error instanceof Error && error.message === "EMAIL_TAKEN") {
      res.status(409).json({ error: "That email is already linked to an account." });
      return;
    }
    if (errorCode(error) === "23505") {
      res.status(409).json({ error: "That username or email is already in use." });
      return;
    }
    throw error;
  }

  const token = await createLocalSession(userId);
  setLocalSessionCookie(req, res, token);
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({
    authenticated: true,
    userId,
    mustChangePassword: false,
  });
});

router.post("/auth/login", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req, res)) return;
  const body = SignInWithPasswordBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter a username or email and password." });
    return;
  }
  const identifier = body.data.identifier.trim().toLowerCase();
  const ip = req.ip || "unknown";
  const identifierKey = `identifier:${identifier}`;
  const ipKey = `ip:${ip}`;
  if (
    isRateLimited(identifierKey, MAX_IDENTIFIER_ATTEMPTS) ||
    isRateLimited(ipKey, MAX_IP_ATTEMPTS)
  ) {
    res.status(429).json({
      error: "Too many sign-in attempts. Wait a little and try again.",
    });
    return;
  }

  const condition = identifier.includes("@")
    ? sql`lower(${storeUsersTable.email}) = ${identifier}`
    : or(
        sql`lower(${storeUsersTable.username}) = ${identifier}`,
        sql`lower(${storeUsersTable.email}) = ${identifier}`,
      );
  const matches = await db
    .select({
      id: storeUsersTable.id,
      passwordHash: storeUsersTable.passwordHash,
      mustChangePassword: storeUsersTable.mustChangePassword,
    })
    .from(storeUsersTable)
    .where(condition)
    .limit(2);
  const user = matches.length === 1 ? matches[0] : undefined;
  const hash = user?.passwordHash ?? (await dummyHashPromise);
  const validPassword = await verifyPassword(body.data.password, hash);
  if (!user || !validPassword) {
    recordFailure(identifierKey);
    recordFailure(ipKey);
    res.status(401).json({ error: "Username or password is incorrect." });
    return;
  }

  clearFailures(identifierKey, ipKey);
  const token = await createLocalSession(user.id);
  setLocalSessionCookie(req, res, token);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    authenticated: true,
    userId: user.id,
    mustChangePassword: user.mustChangePassword,
  });
});

router.post("/auth/sign-out", async (req, res): Promise<void> => {
  if (!requireSameOrigin(req, res)) return;
  const body = SignOutAccountBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid sign-out request." });
    return;
  }
  await revokeRequestSession(req);
  clearLocalSessionCookie(req, res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ complete: true });
});

export default router;
