import { sql } from "drizzle-orm";
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
import { storeroomsTable } from "./storerooms";
import { storeUsersTable } from "./users";

export const storeInvitationsTable = pgTable(
  "store_invitations",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    clerkInvitationId: text("clerk_invitation_id"),
    createdByUserId: text("created_by_user_id").references(
      () => storeUsersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    storeroomIdx: index("store_invitations_storeroom_idx").on(
      table.storeroomId,
    ),
    clerkInvitationUnique: uniqueIndex(
      "store_invitations_clerk_invitation_uidx",
    ).on(table.clerkInvitationId),
    pendingEmailUnique: uniqueIndex("store_invitations_pending_email_uidx")
      .on(table.storeroomId, table.email)
      .where(sql`${table.status} = 'pending'`),
  }),
);

export const insertStoreInvitationSchema = createInsertSchema(
  storeInvitationsTable,
).omit({
  id: true,
  createdAt: true,
  acceptedAt: true,
  revokedAt: true,
});

export type InsertStoreInvitation = z.infer<
  typeof insertStoreInvitationSchema
>;
export type StoreInvitationRecord = typeof storeInvitationsTable.$inferSelect;
