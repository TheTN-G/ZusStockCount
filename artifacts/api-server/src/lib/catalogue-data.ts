import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import {
  db,
  productCategoriesTable,
  productsTable,
  stockBatchesTable,
  stockMovementsTable,
  stockSectionsTable,
} from "@workspace/db";

type Transaction = NodePgTransaction<any, any>;

export const defaultProductCategories = [
  { key: "food", name: "Food" },
  { key: "drink", name: "Drink" },
  { key: "consumable", name: "Consumables" },
  { key: "cleaning", name: "Cleaning" },
  { key: "packaging", name: "Packaging" },
] as const;

export async function ensureDefaultProductCategories(
  tx: Transaction,
  storeroomId: number,
): Promise<void> {
  await tx
    .insert(productCategoriesTable)
    .values(
      defaultProductCategories.map((category) => ({
        storeroomId,
        ...category,
        isDefault: true,
      })),
    )
    .onConflictDoNothing();
}

export async function ensureDefaultStockSection(
  tx: Transaction,
  storeroomId: number,
) {
  let [section] = await tx
    .select()
    .from(stockSectionsTable)
    .where(
      and(
        eq(stockSectionsTable.storeroomId, storeroomId),
        eq(stockSectionsTable.isDefault, true),
      ),
    )
    .limit(1);

  if (!section) {
    const [created] = await tx
      .insert(stockSectionsTable)
      .values({
        storeroomId,
        name: "Main storage",
        isDefault: true,
      })
      .onConflictDoNothing()
      .returning();
    section = created;
  }

  if (!section) {
    [section] = await tx
      .select()
      .from(stockSectionsTable)
      .where(
        and(
          eq(stockSectionsTable.storeroomId, storeroomId),
          eq(stockSectionsTable.isDefault, true),
        ),
      )
      .limit(1);
  }

  if (!section) throw new Error("Could not initialize the outlet's main storage section.");

  await tx
    .update(productsTable)
    .set({ defaultSectionId: section.id })
    .where(
      and(
        eq(productsTable.storeroomId, storeroomId),
        isNull(productsTable.defaultSectionId),
      ),
    );

  const products = await tx
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.storeroomId, storeroomId));
  const productIds = products.map(({ id }) => id);
  if (productIds.length) {
    await tx
      .update(stockBatchesTable)
      .set({ sectionId: section.id })
      .where(
        and(
          isNull(stockBatchesTable.sectionId),
          inArray(stockBatchesTable.productId, productIds),
        ),
      );
    await tx
      .update(stockMovementsTable)
      .set({
        sectionId: section.id,
        sectionNameSnapshot: section.name,
      })
      .where(
        and(
          isNull(stockMovementsTable.sectionId),
          inArray(stockMovementsTable.productId, productIds),
        ),
      );
  }

  return section;
}

export async function ensureOutletInventorySetup(
  storeroomId: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await ensureDefaultProductCategories(tx, storeroomId);
    await ensureDefaultStockSection(tx, storeroomId);
  });
}

export function categoryKeyFromName(name: string): string {
  const key = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return key || "custom";
}
