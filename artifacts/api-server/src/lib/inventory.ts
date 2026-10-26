import { and, asc, desc, eq, gte, ilike, lt, sql } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  db,
  productsTable,
  stockBatchesTable,
  stockMovementsTable,
  stockSectionsTable,
} from "@workspace/db";
import { ApiError } from "./api-error";
import { ensureDefaultStockSection } from "./catalogue-data";

type Transaction = NodePgTransaction<any, any>;

export type ProductFilters = {
  search?: string;
  category?: string;
  active?: boolean;
};

export async function listProducts(
  storeroomId: number,
  filters: ProductFilters = {},
) {
  await db.transaction((tx) => ensureDefaultStockSection(tx, storeroomId));
  const conditions = [eq(productsTable.storeroomId, storeroomId)];
  if (filters.active !== undefined) {
    conditions.push(eq(productsTable.active, filters.active));
  }
  if (filters.category) {
    conditions.push(eq(productsTable.category, filters.category));
  }
  if (filters.search?.trim()) {
    conditions.push(ilike(productsTable.name, `%${filters.search.trim()}%`));
  }

  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      sku: productsTable.sku,
      category: productsTable.category,
      defaultSectionId: productsTable.defaultSectionId,
      tempMinC: productsTable.tempMinC,
      tempMaxC: productsTable.tempMaxC,
      unit: productsTable.unit,
      bundleUnit: productsTable.bundleUnit,
      bundleSize: productsTable.bundleSize,
      minStock: productsTable.minStock,
      minStockUnit: productsTable.minStockUnit,
      preferredSupplierId: productsTable.preferredSupplierId,
      active: productsTable.active,
      stockOnHand: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
    })
    .from(productsTable)
    .leftJoin(stockBatchesTable, eq(stockBatchesTable.productId, productsTable.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(productsTable.id)
    .orderBy(asc(productsTable.name));

  return rows.map((row) => ({
    ...row,
    lowStock:
      row.stockOnHand <
      row.minStock * (row.minStockUnit === "bundle" ? row.bundleSize : 1),
  }));
}

export async function getProduct(storeroomId: number, productId: number) {
  const rows = await listProducts(storeroomId);
  return rows.find((row) => row.id === productId) ?? null;
}

export async function listMovements(storeroomId: number, options: {
  productId?: number;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  sectionName?: string;
  type?: string;
} = {}) {
  await db.transaction((tx) => ensureDefaultStockSection(tx, storeroomId));
  const conditions = [eq(productsTable.storeroomId, storeroomId)];
  if (options.productId !== undefined) {
    conditions.push(eq(stockMovementsTable.productId, options.productId));
  }
  if (options.dateFrom) {
    conditions.push(gte(stockMovementsTable.occurredAt, new Date(options.dateFrom)));
  }
  if (options.dateTo) {
    conditions.push(lt(stockMovementsTable.occurredAt, new Date(options.dateTo)));
  }
  if (options.sectionName) {
    conditions.push(eq(stockMovementsTable.sectionNameSnapshot, options.sectionName));
  }
  if (options.type) {
    conditions.push(eq(stockMovementsTable.type, options.type));
  }
  const query = db
    .select({
      id: stockMovementsTable.id,
      productId: stockMovementsTable.productId,
      productName: productsTable.name,
      type: stockMovementsTable.type,
      quantityDelta: stockMovementsTable.quantityDelta,
      reason: stockMovementsTable.reason,
      actor: stockMovementsTable.actor,
      occurredAt: stockMovementsTable.occurredAt,
      sectionName: stockMovementsTable.sectionNameSnapshot,
      otherOutletName: stockMovementsTable.otherOutletName,
      transferReference: stockMovementsTable.transferReference,
    })
    .from(stockMovementsTable)
    .innerJoin(productsTable, eq(productsTable.id, stockMovementsTable.productId))
    .where(and(...conditions))
    .orderBy(desc(stockMovementsTable.occurredAt));
  const rows = options.limit === undefined
    ? await query
    : await query.limit(options.limit);
  return rows;
}

export async function applyInventoryDelta(
  tx: Transaction,
  input: {
    productId: number;
    productName: string;
    quantityDelta: number;
    reason: string;
    actor: string;
    type: "received" | "adjustment" | "count" | "delivery";
    expiryDate?: string | null;
    sectionId?: number | null;
  },
) {
  const { productId, quantityDelta } = input;
  if (!Number.isFinite(quantityDelta)) {
    throw new ApiError(400, "Quantity must be a valid number.");
  }

  const [product] = await tx
    .select({
      storeroomId: productsTable.storeroomId,
      defaultSectionId: productsTable.defaultSectionId,
    })
    .from(productsTable)
    .where(eq(productsTable.id, productId))
    .for("update")
    .limit(1);
  if (!product?.storeroomId) {
    throw new ApiError(404, "Product not found.");
  }
  const defaultSection = await ensureDefaultStockSection(
    tx,
    product.storeroomId,
  );
  let sectionId = input.sectionId ?? null;
  if (quantityDelta > 0 && !sectionId) {
    sectionId = product.defaultSectionId ?? defaultSection.id;
  }
  if (sectionId) {
    const [section] = await tx
      .select({ id: stockSectionsTable.id })
      .from(stockSectionsTable)
      .where(
        and(
          eq(stockSectionsTable.id, sectionId),
          eq(stockSectionsTable.storeroomId, product.storeroomId),
        ),
      )
      .for("share")
      .limit(1);
    if (!section) {
      throw new ApiError(400, "Choose a storage area from the product's outlet.");
    }
  }

  if (quantityDelta > 0) {
    await tx.insert(stockBatchesTable).values({
      productId,
      sectionId,
      quantity: quantityDelta,
      expiryDate: input.expiryDate ?? null,
      createdBy: input.actor,
    });
  } else if (quantityDelta < 0) {
    let remaining = Math.abs(quantityDelta);
    const conditions = [eq(stockBatchesTable.productId, productId)];
    if (sectionId) conditions.push(eq(stockBatchesTable.sectionId, sectionId));
    const batches = await tx
      .select()
      .from(stockBatchesTable)
      .where(and(...conditions))
      .orderBy(
        asc(sql`${stockBatchesTable.expiryDate} is null`),
        asc(stockBatchesTable.expiryDate),
        asc(stockBatchesTable.receivedAt),
      )
      .for("update");

    const available = batches.reduce((sum, batch) => sum + batch.quantity, 0);
    if (available + quantityDelta < -0.001) {
      throw new ApiError(
        409,
        `Only ${available} ${input.productName} is in stock.`,
      );
    }

    for (const batch of batches) {
      if (remaining <= 0.001) break;
      const removed = Math.min(batch.quantity, remaining);
      await tx
        .update(stockBatchesTable)
        .set({ quantity: Math.max(0, batch.quantity - removed) })
        .where(eq(stockBatchesTable.id, batch.id));
      remaining -= removed;
    }
  }

  if (quantityDelta === 0) return null;
  const [section] = sectionId
    ? await tx
        .select({ name: stockSectionsTable.name })
        .from(stockSectionsTable)
        .where(eq(stockSectionsTable.id, sectionId))
        .limit(1)
    : [];
  const [movement] = await tx
    .insert(stockMovementsTable)
    .values({
      productId,
      type: input.type,
      quantityDelta,
      reason: input.reason,
      actor: input.actor,
      sectionId,
      sectionNameSnapshot: section?.name ?? null,
    })
    .returning();

  return {
    ...movement,
    productName: input.productName,
    sectionName: movement.sectionNameSnapshot,
  };
}

export async function listBatches(storeroomId: number, options: {
  productId?: number;
  expiringWithinDays?: number;
} = {}) {
  await db.transaction((tx) => ensureDefaultStockSection(tx, storeroomId));
  const conditions = [eq(productsTable.storeroomId, storeroomId)];
  if (options.productId) {
    conditions.push(eq(stockBatchesTable.productId, options.productId));
  }
  if (options.expiringWithinDays) {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + options.expiringWithinDays);
    conditions.push(gte(stockBatchesTable.expiryDate, today.toISOString().slice(0, 10)));
    conditions.push(
      sql`${stockBatchesTable.expiryDate} <= ${end.toISOString().slice(0, 10)}`,
    );
  }
  const rows = await db
    .select({
      id: stockBatchesTable.id,
      productId: stockBatchesTable.productId,
      productName: productsTable.name,
      quantity: stockBatchesTable.quantity,
      expiryDate: stockBatchesTable.expiryDate,
      receivedAt: stockBatchesTable.receivedAt,
      sectionId: stockBatchesTable.sectionId,
      sectionName: stockSectionsTable.name,
    })
    .from(stockBatchesTable)
    .innerJoin(productsTable, eq(productsTable.id, stockBatchesTable.productId))
    .leftJoin(
      stockSectionsTable,
      eq(stockSectionsTable.id, stockBatchesTable.sectionId),
    )
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(stockBatchesTable.expiryDate), asc(stockBatchesTable.receivedAt));
  return rows;
}
