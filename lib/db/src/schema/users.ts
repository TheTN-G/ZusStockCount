import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const storeUsersTable = pgTable("store_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  role: text("role").notNull().default("staff"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertStoreUserSchema = createInsertSchema(storeUsersTable).omit({
  createdAt: true,
});
export type InsertStoreUser = z.infer<typeof insertStoreUserSchema>;
export type StoreUserRecord = typeof storeUsersTable.$inferSelect;
