import { createHash } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CompleteStoreUserPasswordResetBody,
  CompleteStoreUserPasswordResetResponse,
} from "@workspace/api-zod";
import {
  authSessionsTable,
  db,
  passwordResetTokensTable,
  storeUsersTable,
} from "@workspace/db";
import { hashPassword } from "../auth/localAuth";

const router: IRouter = Router();

router.post(
  "/users/password-reset/complete",
  async (req, res): Promise<void> => {
    const body = CompleteStoreUserPasswordResetBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        error: "The reset link or password is invalid.",
      });
      return;
    }

    const now = new Date();
    const tokenHash = createHash("sha256")
      .update(body.data.token)
      .digest("hex");
    const [claimedToken] = await db
      .update(passwordResetTokensTable)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokensTable.tokenHash, tokenHash),
          isNull(passwordResetTokensTable.usedAt),
          gt(passwordResetTokensTable.expiresAt, now),
        ),
      )
      .returning({ targetUserId: passwordResetTokensTable.targetUserId });

    if (!claimedToken) {
      res.status(400).json({
        error: "This reset link is invalid, expired, or already used.",
      });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    const passwordHash = await hashPassword(body.data.password);
    await db.transaction(async (tx) => {
      await tx
        .update(storeUsersTable)
        .set({ passwordHash, mustChangePassword: false })
        .where(eq(storeUsersTable.id, claimedToken.targetUserId));
      await tx
        .update(authSessionsTable)
        .set({ revokedAt: now })
        .where(
          and(
            eq(authSessionsTable.userId, claimedToken.targetUserId),
            isNull(authSessionsTable.revokedAt),
          ),
        );
    });

    res.json(CompleteStoreUserPasswordResetResponse.parse({ complete: true }));
  },
);

export default router;
