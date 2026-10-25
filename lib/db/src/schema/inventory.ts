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
import { productsTable } from "./products";
import { stockSectionsTable } from "./catalogue";

export const stockBatchesTable = pgTable(
  "stock_batches",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id),
    sectionId: integer("section_id").references(() => stockSectionsTable.id, {
      onDelete: "set null",
    }),
    quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" })
      .notNull()
      .default(0),
    expiryDate: date("expiry_date", { mode: "string" }),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (table) => ({
    productIdx: index("stock_batches_product_idx").on(table.productId),
    expiryIdx: index("stock_batches_expiry_idx").on(table.expiryDate),
  }),
);

export const stockMovementsTable = pgTable(
  "stock_movements",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id),
    sectionId: integer("section_id").references(() => stockSectionsTable.id, {
      onDelete: "set null",
    }),
    sectionNameSnapshot: text("section_name_snapshot"),
    otherOutletName: text("other_outlet_name"),
    transferReference: text("transfer_reference"),
    type: text("type").notNull(),
    quantityDelta: numeric("quantity_delta", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    productIdx: index("stock_movements_product_idx").on(table.productId),
    occurredIdx: index("stock_movements_occurred_idx").on(table.occurredAt),
  }),
);

export const insertStockBatchSchema = createInsertSchema(stockBatchesTable).omit({
  id: true,
  receivedAt: true,
});
export const insertStockMovementSchema = createInsertSchema(
  stockMovementsTable,
).omit({ id: true, occurredAt: true });
export type InsertStockBatch = z.infer<typeof insertStockBatchSchema>;
export type InsertStockMovement = z.infer<typeof insertStockMovementSchema>;
export type StockBatchRecord = typeof stockBatchesTable.$inferSelect;
export type StockMovementRecord = typeof stockMovementsTable.$inferSelect;
