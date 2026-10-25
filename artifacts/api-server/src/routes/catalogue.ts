import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateProductCategoryBody,
  CreateProductCategoryResponse,
  CreateStockSectionBody,
  CreateStockSectionResponse,
  DeleteProductCategoryParams,
  DeleteStockSectionParams,
  ListProductCategoriesResponse,
  ListStockSectionsResponse,
  UpdateProductCategoryBody,
  UpdateProductCategoryParams,
  UpdateProductCategoryResponse,
  UpdateStockSectionBody,
  UpdateStockSectionParams,
  UpdateStockSectionResponse,
} from "@workspace/api-zod";
import {
  db,
  productCategoriesTable,
  productsTable,
  stockBatchesTable,
  stockCountLinesTable,
  stockCountsTable,
  stockSectionsTable,
} from "@workspace/db";
import { ApiError } from "../lib/api-error";
import {
  categoryKeyFromName,
  ensureDefaultProductCategories,
  ensureDefaultStockSection,
} from "../lib/catalogue-data";
import { requireRoles } from "../middlewares/storeUser";

const router: IRouter = Router();
const editors = requireRoles("owner", "admin", "supervisor");

function hasValidTemperatureRange(
  min: number | null | undefined,
  max: number | null | undefined,
) {
  return (min == null) === (max == null) && (min == null || max == null || min <= max);
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "23505",
  );
}

router.get("/product-categories", async (req, res): Promise<void> => {
  const categories = await db.transaction(async (tx) => {
    await ensureDefaultProductCategories(tx, req.storeroomId!);
    return tx
      .select()
      .from(productCategoriesTable)
      .where(eq(productCategoriesTable.storeroomId, req.storeroomId!))
      .orderBy(productCategoriesTable.name);
  });
  res.json(ListProductCategoriesResponse.parse(categories));
});

router.post(
  "/product-categories",
  editors,
  async (req, res): Promise<void> => {
    const body = CreateProductCategoryBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const name = body.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Enter a category name." });
      return;
    }
    if (!hasValidTemperatureRange(body.data.receivingTempMinC, body.data.receivingTempMaxC)) {
      res.status(400).json({
        error: "Set both receiving temperatures and keep the minimum at or below the maximum.",
      });
      return;
    }
    try {
      const category = await db.transaction(async (tx) => {
        await ensureDefaultProductCategories(tx, req.storeroomId!);
        const [sameName] = await tx
          .select({ id: productCategoriesTable.id })
          .from(productCategoriesTable)
          .where(
            and(
              eq(productCategoriesTable.storeroomId, req.storeroomId!),
              sql`lower(${productCategoriesTable.name}) = lower(${name})`,
            ),
          )
          .limit(1);
        if (sameName) throw new ApiError(409, "A category with that name already exists.");

        const baseKey = categoryKeyFromName(name);
        let key = baseKey;
        let suffix = 2;
        while (true) {
          const [sameKey] = await tx
            .select({ id: productCategoriesTable.id })
            .from(productCategoriesTable)
            .where(
              and(
                eq(productCategoriesTable.storeroomId, req.storeroomId!),
                eq(productCategoriesTable.key, key),
              ),
            )
            .limit(1);
          if (!sameKey) break;
          key = `${baseKey.slice(0, 68)}-${suffix++}`;
        }
        const [created] = await tx
          .insert(productCategoriesTable)
          .values({
            storeroomId: req.storeroomId!,
            key,
            name,
            receivingTempMinC: body.data.receivingTempMinC ?? null,
            receivingTempMaxC: body.data.receivingTempMaxC ?? null,
            receivingHandlingSop: body.data.receivingHandlingSop?.trim() ?? "",
          })
          .returning();
        return created;
      });
      res.status(201).json(CreateProductCategoryResponse.parse(category));
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "A category with that name already exists." });
        return;
      }
      throw error;
    }
  },
);

router.patch(
  "/product-categories/:categoryId",
  editors,
  async (req, res): Promise<void> => {
    const params = UpdateProductCategoryParams.safeParse(req.params);
    const body = UpdateProductCategoryBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const name = body.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Enter a category name." });
      return;
    }
    try {
      const category = await db.transaction(async (tx) => {
        await ensureDefaultProductCategories(tx, req.storeroomId!);
        const [current] = await tx
          .select()
          .from(productCategoriesTable)
          .where(
            and(
              eq(productCategoriesTable.id, params.data.categoryId),
              eq(productCategoriesTable.storeroomId, req.storeroomId!),
            ),
          )
          .for("update")
          .limit(1);
        if (!current) throw new ApiError(404, "Category not found in this outlet.");
        const receivingTempMinC =
          body.data.receivingTempMinC === undefined
            ? current.receivingTempMinC
            : body.data.receivingTempMinC;
        const receivingTempMaxC =
          body.data.receivingTempMaxC === undefined
            ? current.receivingTempMaxC
            : body.data.receivingTempMaxC;
        if (!hasValidTemperatureRange(receivingTempMinC, receivingTempMaxC)) {
          throw new ApiError(
            400,
            "Set both receiving temperatures and keep the minimum at or below the maximum.",
          );
        }
        const [sameName] = await tx
          .select({ id: productCategoriesTable.id })
          .from(productCategoriesTable)
          .where(
            and(
              eq(productCategoriesTable.storeroomId, req.storeroomId!),
              sql`lower(${productCategoriesTable.name}) = lower(${name})`,
              sql`${productCategoriesTable.id} <> ${current.id}`,
            ),
          )
          .limit(1);
        if (sameName) throw new ApiError(409, "A category with that name already exists.");
        const [updated] = await tx
          .update(productCategoriesTable)
          .set({
            name,
            ...(body.data.receivingTempMinC === undefined
              ? {}
              : { receivingTempMinC: body.data.receivingTempMinC }),
            ...(body.data.receivingTempMaxC === undefined
              ? {}
              : { receivingTempMaxC: body.data.receivingTempMaxC }),
            ...(body.data.receivingHandlingSop === undefined
              ? {}
              : { receivingHandlingSop: body.data.receivingHandlingSop.trim() }),
          })
          .where(eq(productCategoriesTable.id, current.id))
          .returning();
        return updated;
      });
      res.json(UpdateProductCategoryResponse.parse(category));
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "A category with that name already exists." });
        return;
      }
      throw error;
    }
  },
);

router.delete(
  "/product-categories/:categoryId",
  editors,
  async (req, res): Promise<void> => {
    const params = DeleteProductCategoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        const [category] = await tx
          .select()
          .from(productCategoriesTable)
          .where(
            and(
              eq(productCategoriesTable.id, params.data.categoryId),
              eq(productCategoriesTable.storeroomId, req.storeroomId!),
            ),
          )
          .for("update")
          .limit(1);
        if (!category) throw new ApiError(404, "Category not found in this outlet.");
        const [assigned] = await tx
          .select({ id: productsTable.id })
          .from(productsTable)
          .where(
            and(
              eq(productsTable.storeroomId, req.storeroomId!),
              eq(productsTable.category, category.key),
            ),
          )
          .limit(1);
        if (assigned) {
          throw new ApiError(409, "Move products to another category before deleting this one.");
        }
        await tx
          .delete(productCategoriesTable)
          .where(eq(productCategoriesTable.id, category.id));
      });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    res.status(204).end();
  },
);

router.get("/stock-sections", async (req, res): Promise<void> => {
  await db.transaction((tx) => ensureDefaultStockSection(tx, req.storeroomId!));
  const sections = await db
    .select({
      id: stockSectionsTable.id,
      name: stockSectionsTable.name,
      isDefault: stockSectionsTable.isDefault,
      quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
    })
    .from(stockSectionsTable)
    .leftJoin(
      stockBatchesTable,
      eq(stockBatchesTable.sectionId, stockSectionsTable.id),
    )
    .where(eq(stockSectionsTable.storeroomId, req.storeroomId!))
    .groupBy(stockSectionsTable.id)
    .orderBy(desc(stockSectionsTable.isDefault), asc(stockSectionsTable.name));
  res.json(ListStockSectionsResponse.parse(sections));
});

router.post(
  "/stock-sections",
  editors,
  async (req, res): Promise<void> => {
    const body = CreateStockSectionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const name = body.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Enter a storage area name." });
      return;
    }
    try {
      await db.transaction((tx) => ensureDefaultStockSection(tx, req.storeroomId!));
      const [section] = await db
        .insert(stockSectionsTable)
        .values({ storeroomId: req.storeroomId!, name })
        .returning();
      res.status(201).json(
        CreateStockSectionResponse.parse({ ...section, quantity: 0 }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "A storage area with that name already exists." });
        return;
      }
      throw error;
    }
  },
);

router.patch(
  "/stock-sections/:sectionId",
  editors,
  async (req, res): Promise<void> => {
    const params = UpdateStockSectionParams.safeParse(req.params);
    const body = UpdateStockSectionBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const name = body.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Enter a storage area name." });
      return;
    }
    try {
      const [section] = await db
        .update(stockSectionsTable)
        .set({ name })
        .where(
          and(
            eq(stockSectionsTable.id, params.data.sectionId),
            eq(stockSectionsTable.storeroomId, req.storeroomId!),
          ),
        )
        .returning();
      if (!section) {
        res.status(404).json({ error: "Storage area not found in this outlet." });
        return;
      }
      const [total] = await db
        .select({
          quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
        })
        .from(stockBatchesTable)
        .where(eq(stockBatchesTable.sectionId, section.id));
      res.json(
        UpdateStockSectionResponse.parse({
          ...section,
          quantity: total?.quantity ?? 0,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: "A storage area with that name already exists." });
        return;
      }
      throw error;
    }
  },
);

router.delete(
  "/stock-sections/:sectionId",
  editors,
  async (req, res): Promise<void> => {
    const params = DeleteStockSectionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        const [section] = await tx
          .select()
          .from(stockSectionsTable)
          .where(
            and(
              eq(stockSectionsTable.id, params.data.sectionId),
              eq(stockSectionsTable.storeroomId, req.storeroomId!),
            ),
          )
          .for("update")
          .limit(1);
        if (!section) throw new ApiError(404, "Storage area not found in this outlet.");
        if (section.isDefault) {
          throw new ApiError(409, "The main storage area cannot be deleted; you can rename it instead.");
        }
        const [stock] = await tx
          .select({ id: stockBatchesTable.id })
          .from(stockBatchesTable)
          .where(
            and(
              eq(stockBatchesTable.sectionId, section.id),
              gt(stockBatchesTable.quantity, 0),
            ),
          )
          .limit(1);
        if (stock) {
          throw new ApiError(409, "Transfer or adjust the remaining stock before deleting this storage area.");
        }
        const [productDefault] = await tx
          .select({ id: productsTable.id })
          .from(productsTable)
          .where(
            and(
              eq(productsTable.storeroomId, req.storeroomId!),
              eq(productsTable.defaultSectionId, section.id),
            ),
          )
          .limit(1);
        if (productDefault) {
          throw new ApiError(409, "Change products' default stock section before deleting this storage area.");
        }
        const [activeCountLine] = await tx
          .select({ id: stockCountLinesTable.id })
          .from(stockCountLinesTable)
          .innerJoin(
            stockCountsTable,
            eq(stockCountsTable.id, stockCountLinesTable.countId),
          )
          .where(
            and(
              eq(stockCountLinesTable.sectionId, section.id),
              eq(stockCountsTable.status, "in_progress"),
            ),
          )
          .limit(1);
        if (activeCountLine) {
          throw new ApiError(409, "Finish the in-progress stock count before deleting this storage area.");
        }
        await tx.delete(stockSectionsTable).where(eq(stockSectionsTable.id, section.id));
      });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    res.status(204).end();
  },
);

export default router;
