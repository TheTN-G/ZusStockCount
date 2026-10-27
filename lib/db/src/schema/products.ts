import {
  boolean,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { stockSectionsTable } from "./catalogue";
import { storeroomsTable } from "./storerooms";
import { suppliersTable } from "./suppliers";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  storeroomId: integer("storeroom_id").references(() => storeroomsTable.id),
  defaultSectionId: integer("default_section_id").references(
    () => stockSectionsTable.id,
    { onDelete: "set null" },
  ),
  name: text("name").notNull(),
  sku: text("sku"),
  category: text("category").notNull(),
  storage: text("storage").notNull(),
  unit: text("unit").notNull(),
  bundleUnit: text("bundle_unit").notNull().default("bundle"),
  bundleSize: numeric("bundle_size", { precision: 12, scale: 2, mode: "number" })
    .notNull()
    .default(1),
  minStock: numeric("min_stock", { precision: 12, scale: 2, mode: "number" })
    .notNull()
    .default(0),
  minStockUnit: text("min_stock_unit").notNull().default("unit"),
  preferredSupplierId: integer("preferred_supplier_id").references(
    () => suppliersTable.id,
    { onDelete: "set null" },
  ),
  tempMinC: numeric("temp_min_c", { precision: 6, scale: 2, mode: "number" }),
  tempMaxC: numeric("temp_max_c", { precision: 6, scale: 2, mode: "number" }),
  handlingSop: text("handling_sop").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertProductSchema = createInsertSchema(productsTable).omit({
  id: true,
  storeroomId: true,
  createdAt: true,
});
export type InsertProduct = z.infer<typeof insertProductSchema>;
export type ProductRecord = typeof productsTable.$inferSelect;
