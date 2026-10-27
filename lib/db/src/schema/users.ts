import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const storeUsersTable = pgTable(
  "store_users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().default(""),
    username: text("username"),
    passwordHash: text("password_hash"),
    mustChangePassword: boolean("must_change_password")
      .notNull()
      .default(false),
    role: text("role").notNull().default("staff"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    usernameUnique: uniqueIndex("store_users_username_lower_uidx")
      .on(sql`lower(${table.username})`)
      .where(sql`${table.username} IS NOT NULL`),
  }),
);

export const authSessionsTable = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => storeUsersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdx: index("auth_sessions_user_idx").on(table.userId),
  }),
);

export const insertStoreUserSchema = createInsertSchema(storeUsersTable).omit({
  createdAt: true,
});
export type InsertStoreUser = z.infer<typeof insertStoreUserSchema>;
export type StoreUserRecord = typeof storeUsersTable.$inferSelect;
