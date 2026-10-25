import {
  index,
  boolean,
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

export const suppliersTable = pgTable(
  "suppliers",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    phone: text("phone"),
    email: text("email"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    storeroomIdx: index("suppliers_storeroom_idx").on(table.storeroomId),
    nameUnique: uniqueIndex("suppliers_storeroom_name_uidx").on(
      table.storeroomId,
      table.name,
    ),
  }),
);

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({
  id: true,
  storeroomId: true,
  createdAt: true,
});
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export type SupplierRecord = typeof suppliersTable.$inferSelect;
