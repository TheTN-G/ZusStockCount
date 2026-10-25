import { index, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { storeroomsTable } from "./storerooms";
import { workspacesTable } from "./workspaces";
import { productsTable } from "./products";
import { stockSectionsTable } from "./catalogue";

export const stockTransfersTable = pgTable(
  "stock_transfers",
  {
    id: serial("id").primaryKey(),
    reference: text("reference").notNull().unique(),
    clientKey: text("client_key").notNull(),
    requestHash: text("request_hash").notNull(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "restrict" }),
    sourceStoreroomId: integer("source_storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "restrict" }),
    destinationStoreroomId: integer("destination_storeroom_id")
      .notNull()
      .references(() => storeroomsTable.id, { onDelete: "restrict" }),
    sourceProductId: integer("source_product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "restrict" }),
    destinationProductId: integer("destination_product_id")
      .notNull()
      .references(() => productsTable.id, { onDelete: "restrict" }),
    sourceSectionId: integer("source_section_id").references(
      () => stockSectionsTable.id,
      { onDelete: "set null" },
    ),
    destinationSectionId: integer("destination_section_id").references(
      () => stockSectionsTable.id,
      { onDelete: "set null" },
    ),
    sourceOutletName: text("source_outlet_name").notNull(),
    destinationOutletName: text("destination_outlet_name").notNull(),
    sourceProductName: text("source_product_name").notNull(),
    destinationProductName: text("destination_product_name").notNull(),
    sourceSectionName: text("source_section_name").notNull(),
    destinationSectionName: text("destination_section_name").notNull(),
    unit: text("unit").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 2, mode: "number" }).notNull(),
    sourceBefore: numeric("source_before", { precision: 12, scale: 2, mode: "number" }).notNull(),
    sourceAfter: numeric("source_after", { precision: 12, scale: 2, mode: "number" }).notNull(),
    destinationBefore: numeric("destination_before", { precision: 12, scale: 2, mode: "number" }).notNull(),
    destinationAfter: numeric("destination_after", { precision: 12, scale: 2, mode: "number" }).notNull(),
    sourceTotalBefore: numeric("source_total_before", { precision: 12, scale: 2, mode: "number" }).notNull(),
    sourceTotalAfter: numeric("source_total_after", { precision: 12, scale: 2, mode: "number" }).notNull(),
    destinationTotalBefore: numeric("destination_total_before", { precision: 12, scale: 2, mode: "number" }).notNull(),
    destinationTotalAfter: numeric("destination_total_after", { precision: 12, scale: 2, mode: "number" }).notNull(),
    note: text("note").notNull().default(""),
    actor: text("actor").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    clientKeyUnique: uniqueIndex("stock_transfers_client_key_uidx").on(table.clientKey),
    sourceRoomIdx: index("stock_transfers_source_room_idx").on(
      table.sourceStoreroomId,
      table.occurredAt,
    ),
    destinationRoomIdx: index("stock_transfers_destination_room_idx").on(
      table.destinationStoreroomId,
      table.occurredAt,
    ),
    workspaceIdx: index("stock_transfers_workspace_idx").on(
      table.workspaceId,
      table.occurredAt,
    ),
  }),
);
