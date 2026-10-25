import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { storeroomsTable } from "./storerooms";

export const productCategoriesTable = pgTable(
  "product_categories",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    key: text("category_key").notNull(),
    name: text("name").notNull(),
    receivingTempMinC: numeric("receiving_temp_min_c", {
      precision: 6,
      scale: 2,
      mode: "number",
    }),
    receivingTempMaxC: numeric("receiving_temp_max_c", {
      precision: 6,
      scale: 2,
      mode: "number",
    }),
    receivingHandlingSop: text("receiving_handling_sop").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    keyUnique: uniqueIndex("product_categories_room_key_uidx").on(
      table.storeroomId,
      table.key,
    ),
    nameUnique: uniqueIndex("product_categories_room_name_uidx").on(
      table.storeroomId,
      sql`lower(${table.name})`,
    ),
    roomIdx: index("product_categories_room_idx").on(table.storeroomId),
  }),
);

export const stockSectionsTable = pgTable(
  "stock_sections",
  {
    id: serial("id").primaryKey(),
    storeroomId: integer("storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameUnique: uniqueIndex("stock_sections_room_name_uidx").on(
      table.storeroomId,
      sql`lower(${table.name})`,
    ),
    oneDefaultPerRoom: uniqueIndex("stock_sections_one_default_per_room_uidx")
      .on(table.storeroomId)
      .where(sql`${table.isDefault} = true`),
    roomIdx: index("stock_sections_room_idx").on(table.storeroomId),
  }),
);
