import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { storeroomsTable } from "./storerooms";
import { storeUsersTable } from "./users";

export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    targetUserId: text("target_user_id")
      .notNull()
      .references(() => storeUsersTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => storeUsersTable.id, {
      onDelete: "set null",
    }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("password_reset_tokens_token_hash_unique").on(
      table.tokenHash,
    ),
    targetOutletIdx: index("password_reset_tokens_target_outlet_idx").on(
      table.targetUserId,
      table.storeroomId,
    ),
  }),
);

export type PasswordResetTokenRecord =
  typeof passwordResetTokensTable.$inferSelect;
