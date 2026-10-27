import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { storeroomsTable } from "./storerooms";
import { storeUsersTable } from "./users";

export const securityEventsTable = pgTable(
  "security_events",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => storeUsersTable.id, {
      onDelete: "set null",
    }),
    targetUserId: text("target_user_id").references(() => storeUsersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name").notNull(),
    targetName: text("target_name").notNull(),
    eventType: text("event_type").notNull(),
    changedSections: jsonb("changed_sections")
      .$type<Array<{ section: string; previousAccess: string; newAccess: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    storeroomCreatedIdx: index("security_events_storeroom_created_idx").on(
      table.storeroomId,
      table.createdAt,
    ),
  }),
);

export const insertSecurityEventSchema = createInsertSchema(
  securityEventsTable,
).omit({ id: true, createdAt: true });
export type InsertSecurityEvent = z.infer<typeof insertSecurityEventSchema>;
export type SecurityEventRecord = typeof securityEventsTable.$inferSelect;
