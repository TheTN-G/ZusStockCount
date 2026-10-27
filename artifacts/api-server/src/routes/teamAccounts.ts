import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { CreateStoreAccountBody } from "@workspace/api-zod";
import {
  db,
  storeUsersTable,
  storeroomMembershipsTable,
} from "@workspace/db";
import { hashPassword, normalizeUsername } from "../auth/localAuth";
import { requireRoles } from "../middlewares/storeUser";
import { effectiveStoreAccess } from "../lib/storeAccess";

const router: IRouter = Router();

router.post(
  "/users/accounts",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const body = CreateStoreAccountBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Enter valid teammate account details." });
      return;
    }
    if (
      req.storeMembership!.role === "supervisor" &&
      body.data.role !== "staff"
    ) {
      res.status(403).json({
        error: "Managers can create staff accounts only.",
      });
      return;
    }

    const name = body.data.name.trim();
    const username = normalizeUsername(body.data.username);
    const email = body.data.email?.trim().toLowerCase() ?? "";
    if (!name) {
      res.status(400).json({ error: "Teammate name cannot be blank." });
      return;
    }

    const passwordHash = await hashPassword(body.data.temporaryPassword);
    const userId = `local_${randomUUID()}`;
    const access =
      body.data.role === "staff"
        ? effectiveStoreAccess("staff", body.data.access)
        : null;
    try {
      const member = await db.transaction(async (tx) => {
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
        const [user] = await tx
          .insert(storeUsersTable)
          .values({
            id: userId,
            name,
            username,
            email,
            role: body.data.role,
            passwordHash,
            mustChangePassword: true,
          })
          .returning();
        await tx.insert(storeroomMembershipsTable).values({
          storeroomId: req.storeroomId!,
          userId,
          role: body.data.role,
          permissions: access,
        });
        return user;
      });

      res.status(201).json({
        id: member.id,
        name: member.name,
        username: member.username,
        email: member.email,
        role: body.data.role,
        storeName: req.storeroom!.name,
        mustChangePassword: member.mustChangePassword,
        access: effectiveStoreAccess(body.data.role, access),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "USERNAME_TAKEN" || error.message === "EMAIL_TAKEN")
      ) {
        res.status(409).json({
          error:
            error.message === "USERNAME_TAKEN"
              ? "That username is already in use."
              : "That email is already linked to an account.",
        });
        return;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "23505"
      ) {
        res.status(409).json({ error: "That username is already in use." });
        return;
      }
      throw error;
    }
  },
);

export default router;
