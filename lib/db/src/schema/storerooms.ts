import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { storeUsersTable } from "./users";
import { workspacesTable } from "./workspaces";

export const storeroomsTable = pgTable(
  "storerooms",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id").references(() => workspacesTable.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    businessAddress: text("business_address"),
    ownerUserId: text("owner_user_id").references(() => storeUsersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    ownerIdx: index("storerooms_owner_idx").on(table.ownerUserId),
    workspaceIdx: index("storerooms_workspace_idx").on(table.workspaceId),
  }),
);

export const storeroomMembershipsTable = pgTable(
  "storeroom_memberships",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => storeUsersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("staff"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userRoomUnique: uniqueIndex("storeroom_memberships_user_room_uidx").on(
      table.userId,
      table.storeroomId,
    ),
    storeroomIdx: index("storeroom_memberships_storeroom_idx").on(
      table.storeroomId,
    ),
  }),
);

export const insertStoreroomSchema = createInsertSchema(storeroomsTable).omit({
  id: true,
  workspaceId: true,
  ownerUserId: true,
  createdAt: true,
});
export const insertStoreroomMembershipSchema = createInsertSchema(
  storeroomMembershipsTable,
).omit({ id: true, createdAt: true });

export type InsertStoreroom = z.infer<typeof insertStoreroomSchema>;
export type StoreroomRecord = typeof storeroomsTable.$inferSelect;
export type StoreroomMembershipRecord =
  typeof storeroomMembershipsTable.$inferSelect;
