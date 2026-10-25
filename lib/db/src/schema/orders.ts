import {
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
import { suppliersTable } from "./suppliers";

export const purchaseOrdersTable = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id").references(() => storeroomsTable.id),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by").notNull(),
    reviewedBy: text("reviewed_by"),
    supplierId: integer("supplier_id").references(() => suppliersTable.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusIdx: index("purchase_orders_status_idx").on(table.status),
    createdIdx: index("purchase_orders_created_idx").on(table.createdAt),
  }),
);

export const purchaseOrderLinesTable = pgTable(
  "purchase_order_lines",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id),
    productName: text("product_name").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" })
      .notNull(),
    receivedQuantity: numeric("received_quantity", {
      precision: 12,
      scale: 2,
      mode: "number",
    })
      .notNull()
      .default(0),
    unit: text("unit").notNull(),
  },
  (table) => ({
    orderIdx: index("purchase_order_lines_order_idx").on(table.orderId),
  }),
);

export const insertPurchaseOrderSchema = createInsertSchema(
  purchaseOrdersTable,
).omit({ id: true, storeroomId: true, createdAt: true, updatedAt: true });
export const insertPurchaseOrderLineSchema = createInsertSchema(
  purchaseOrderLinesTable,
).omit({ id: true });
export type InsertPurchaseOrder = z.infer<typeof insertPurchaseOrderSchema>;
export type InsertPurchaseOrderLine = z.infer<typeof insertPurchaseOrderLineSchema>;
export type PurchaseOrderRecord = typeof purchaseOrdersTable.$inferSelect;
export type PurchaseOrderLineRecord = typeof purchaseOrderLinesTable.$inferSelect;
