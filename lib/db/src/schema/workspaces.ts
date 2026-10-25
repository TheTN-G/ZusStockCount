import {
  boolean,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { storeUsersTable } from "./users";

export const workspacesTable = pgTable(
  "workspaces",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    businessAddress: text("business_address"),
    setupComplete: boolean("setup_complete").notNull().default(true),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => storeUsersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerUnique: uniqueIndex("workspaces_owner_user_uidx").on(table.ownerUserId),
  }),
);

export const insertWorkspaceSchema = createInsertSchema(workspacesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertWorkspace = z.infer<typeof insertWorkspaceSchema>;
export type WorkspaceRecord = typeof workspacesTable.$inferSelect;
