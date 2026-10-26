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
import { productsTable } from "./products";
import { storeroomsTable } from "./storerooms";
import { stockSectionsTable } from "./catalogue";

export const stockCountsTable = pgTable(
  "stock_counts",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id").references(() => storeroomsTable.id),
    scope: text("scope").notNull(),
    status: text("status").notNull().default("in_progress"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    workbookObjectPath: text("workbook_object_path"),
    workbookName: text("workbook_name"),
    workbookUploadedByUserId: text("workbook_uploaded_by_user_id"),
    workbookUploadedBy: text("workbook_uploaded_by"),
    workbookSubmittedAt: timestamp("workbook_submitted_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("stock_counts_status_idx").on(table.status),
    createdIdx: index("stock_counts_created_idx").on(table.createdAt),
  }),
);

export const stockCountLinesTable = pgTable(
  "stock_count_lines",
  {
    id: serial("id").primaryKey(),
    countId: integer("count_id")
      .notNull()
      .references(() => stockCountsTable.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => productsTable.id),
    sectionId: integer("section_id").references(
      () => stockSectionsTable.id,
      { onDelete: "set null" },
    ),
    sectionNameSnapshot: text("section_name_snapshot"),
    productName: text("product_name").notNull(),
    expectedQuantity: numeric("expected_quantity", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    countedQuantity: numeric("counted_quantity", {
      precision: 12,
      scale: 2,
      mode: "number",
    }),
    unit: text("unit").notNull(),
  },
  (table) => ({
    countIdx: index("stock_count_lines_count_idx").on(table.countId),
    sectionIdx: index("stock_count_lines_section_idx").on(table.sectionId),
  }),
);

export const insertStockCountSchema = createInsertSchema(stockCountsTable).omit({
  id: true,
  storeroomId: true,
  createdAt: true,
  completedAt: true,
});
export const insertStockCountLineSchema = createInsertSchema(
  stockCountLinesTable,
).omit({ id: true });
export type InsertStockCount = z.infer<typeof insertStockCountSchema>;
export type InsertStockCountLine = z.infer<typeof insertStockCountLineSchema>;
export type StockCountRecord = typeof stockCountsTable.$inferSelect;
export type StockCountLineRecord = typeof stockCountLinesTable.$inferSelect;
