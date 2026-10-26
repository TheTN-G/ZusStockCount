import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { storeroomsTable } from "./storerooms";
import { productsTable } from "./products";
import { purchaseOrdersTable } from "./orders";
import { suppliersTable } from "./suppliers";
import { stockSectionsTable } from "./catalogue";

export const deliveriesTable = pgTable(
  "deliveries",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id").references(() => suppliersTable.id, {
      onDelete: "set null",
    }),
    purchaseOrderId: integer("purchase_order_id").references(
      () => purchaseOrdersTable.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull(),
    recordedBy: text("recorded_by").notNull(),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    storeroomIdx: index("deliveries_storeroom_idx").on(table.storeroomId),
    createdIdx: index("deliveries_created_idx").on(table.createdAt),
  }),
);

export const deliveryLinesTable = pgTable(
  "delivery_lines",
  {
    id: serial("id").primaryKey(),
    deliveryId: integer("delivery_id")
      .notNull()
      .references(() => deliveriesTable.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id),
    productName: text("product_name").notNull(),
    sectionId: integer("section_id").references(() => stockSectionsTable.id, {
      onDelete: "set null",
    }),
    sectionNameSnapshot: text("section_name_snapshot"),
    quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" })
      .notNull(),
    tempC: numeric("temp_c", { precision: 6, scale: 2, mode: "number" }),
    expiryDate: date("expiry_date", { mode: "string" }),
    checkStatus: text("check_status").notNull(),
    issue: text("issue"),
  },
  (table) => ({
    deliveryIdx: index("delivery_lines_delivery_idx").on(table.deliveryId),
    productIdx: index("delivery_lines_product_idx").on(table.productId),
  }),
);

export const insertDeliverySchema = createInsertSchema(deliveriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDelivery = z.infer<typeof insertDeliverySchema>;
export type DeliveryRecord = typeof deliveriesTable.$inferSelect;
export type DeliveryLineRecord = typeof deliveryLinesTable.$inferSelect;
