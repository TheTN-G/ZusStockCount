import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { Request, Response } from "express";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { authSessionsTable, db } from "@workspace/db";

const SESSION_COOKIE = "zus_session";
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;

function deriveKey(password: string, salt: Buffer, cost = 16_384) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_KEY_LENGTH,
      { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key as Buffer)),
    );
  });
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function usernameIsValid(username: string): boolean {
  return /^[a-z0-9._-]{3,32}$/.test(normalizeUsername(username));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string | null | undefined,
): Promise<boolean> {
  if (!encoded) return false;
  const [algorithm, costValue, blockValue, parallelValue, saltValue, keyValue] =
    encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    costValue !== "16384" ||
    blockValue !== "8" ||
    parallelValue !== "1" ||
    !saltValue ||
    !keyValue
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(keyValue, "base64url");
    if (salt.length !== 16 || expected.length !== PASSWORD_KEY_LENGTH) {
      return false;
    }
    const actual = await deriveKey(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createLocalSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(authSessionsTable).values({
    id: randomUUID(),
    userId,
    tokenHash: tokenHash(token),
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_MS),
  });
  return token;
}

function requestCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.get("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function findLocalSession(req: Request) {
  const token = requestCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const [session] = await db
    .select({
      id: authSessionsTable.id,
      userId: authSessionsTable.userId,
    })
    .from(authSessionsTable)
    .where(
      and(
        eq(authSessionsTable.tokenHash, tokenHash(token)),
        isNull(authSessionsTable.revokedAt),
        gt(authSessionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return session ?? null;
}

export function setLocalSessionCookie(
  req: Request,
  res: Response,
  token: string,
): void {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: req.secure || forwardedProto === "https",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_LIFETIME_MS,
  });
}

export function clearLocalSessionCookie(
  req: Request,
  res: Response,
): void {
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: req.secure || forwardedProto === "https",
    sameSite: "lax",
    path: "/",
  });
}

export function requireSameOrigin(req: Request, res: Response): boolean {
  if (req.get("sec-fetch-site") === "cross-site") {
    res.status(403).json({ error: "Request origin is not allowed." });
    return false;
  }
  const origin = req.get("origin");
  const host = req.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        res.status(403).json({ error: "Request origin is not allowed." });
        return false;
      }
    } catch {
      res.status(403).json({ error: "Request origin is not allowed." });
      return false;
    }
  }
  return true;
}

export async function revokeLocalSessions(
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  const conditions = [
    eq(authSessionsTable.userId, userId),
    isNull(authSessionsTable.revokedAt),
  ];
  if (exceptSessionId) {
    conditions.push(ne(authSessionsTable.id, exceptSessionId));
  }
  await db
    .update(authSessionsTable)
    .set({ revokedAt: new Date() })
    .where(and(...conditions));
}

export async function revokeRequestSession(req: Request): Promise<void> {
  const session = await findLocalSession(req);
  if (!session) return;
  await db
    .update(authSessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(authSessionsTable.id, session.id));
}
