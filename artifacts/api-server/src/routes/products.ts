import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateProductBody,
  CreateProductResponse,
  GetProductParams,
  GetProductResponse,
  ListProductsQueryParams,
  ListProductsResponse,
  UpdateProductBody,
  UpdateProductParams,
  UpdateProductResponse,
} from "@workspace/api-zod";
import {
  db,
  productCategoriesTable,
  productsTable,
  stockSectionsTable,
} from "@workspace/db";
import { ApiError } from "../lib/api-error";
import {
  ensureDefaultProductCategories,
  ensureDefaultStockSection,
} from "../lib/catalogue-data";
import { requireRoles } from "../middlewares/storeUser";
import { getProduct, listProducts } from "../lib/inventory";

const router: IRouter = Router();

function hasValidTemperatureRange(
  min: number | null | undefined,
  max: number | null | undefined,
) {
  return (min == null) === (max == null) && (min == null || max == null || min <= max);
}

router.get("/products", async (req, res): Promise<void> => {
  const parsed = ListProductsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const products = await listProducts(req.storeroomId!, parsed.data);
  res.json(ListProductsResponse.parse(products));
});

router.post(
  "/products",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const parsed = CreateProductBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    if (!hasValidTemperatureRange(parsed.data.tempMinC, parsed.data.tempMaxC)) {
      res.status(400).json({
        error: "Set both product temperature limits and keep the minimum at or below the maximum.",
      });
      return;
    }
    const product = await db.transaction(async (tx) => {
      await ensureDefaultProductCategories(tx, req.storeroomId!);
      const defaultSection = await ensureDefaultStockSection(tx, req.storeroomId!);
      const defaultSectionId = parsed.data.defaultSectionId ?? defaultSection.id;
      const [section] = await tx
        .select({ id: stockSectionsTable.id })
        .from(stockSectionsTable)
        .where(and(
          eq(stockSectionsTable.id, defaultSectionId),
          eq(stockSectionsTable.storeroomId, req.storeroomId!),
        ))
        .for("share")
        .limit(1);
      if (!section) throw new ApiError(400, "Choose a stock section configured for this outlet.");
      const [category] = await tx
        .select({ key: productCategoriesTable.key })
        .from(productCategoriesTable)
        .where(and(
          eq(productCategoriesTable.storeroomId, req.storeroomId!),
          eq(productCategoriesTable.key, parsed.data.category),
        ))
        .for("share")
        .limit(1);
      if (!category) throw new ApiError(400, "Choose a category configured for this outlet.");
      const [created] = await tx
        .insert(productsTable)
        .values({
          ...parsed.data,
          sku: parsed.data.sku ?? null,
          defaultSectionId,
          storage: "ambient",
          tempMinC: parsed.data.tempMinC ?? null,
          tempMaxC: parsed.data.tempMaxC ?? null,
          handlingSop: "",
          storeroomId: req.storeroomId!,
        })
        .returning();
      return created;
    }).catch((error: unknown) => {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return null;
      }
      throw error;
    });
    if (!product) return;
    res.status(201).json(
      CreateProductResponse.parse({
        ...product,
        stockOnHand: 0,
        lowStock: 0 < product.minStock,
      }),
    );
  },
);

router.get("/products/:productId", async (req, res): Promise<void> => {
  const params = GetProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const product = await getProduct(req.storeroomId!, params.data.productId);
  if (!product) {
    res.status(404).json({ error: "Product not found." });
    return;
  }
  res.json(GetProductResponse.parse(product));
});

router.patch(
  "/products/:productId",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = UpdateProductParams.safeParse(req.params);
    const body = UpdateProductBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (Object.keys(body.data).length === 0) {
      res.status(400).json({ error: "Provide at least one product field." });
      return;
    }
    if (body.data.defaultSectionId != null) {
      const [section] = await db
        .select({ id: stockSectionsTable.id })
        .from(stockSectionsTable)
        .where(and(
          eq(stockSectionsTable.id, body.data.defaultSectionId),
          eq(stockSectionsTable.storeroomId, req.storeroomId!),
        ))
        .limit(1);
      if (!section) {
        res.status(400).json({ error: "Choose a stock section configured for this outlet." });
        return;
      }
    }
    if (body.data.category !== undefined) {
      await db.transaction(async (tx) => {
        await ensureDefaultProductCategories(tx, req.storeroomId!);
        const [category] = await tx
          .select({ key: productCategoriesTable.key })
          .from(productCategoriesTable)
          .where(and(
            eq(productCategoriesTable.storeroomId, req.storeroomId!),
            eq(productCategoriesTable.key, body.data.category!),
          ))
          .for("share")
          .limit(1);
        if (!category) throw new ApiError(400, "Choose a category configured for this outlet.");
      }).catch((error: unknown) => {
        if (error instanceof ApiError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      });
      if (res.headersSent) return;
    }
    const [current] = await db
      .select({
        id: productsTable.id,
        tempMinC: productsTable.tempMinC,
        tempMaxC: productsTable.tempMaxC,
      })
      .from(productsTable)
      .where(and(
        eq(productsTable.id, params.data.productId),
        eq(productsTable.storeroomId, req.storeroomId!),
      ))
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "Product not found." });
      return;
    }
    const nextTempMinC =
      body.data.tempMinC === undefined ? current.tempMinC : body.data.tempMinC;
    const nextTempMaxC =
      body.data.tempMaxC === undefined ? current.tempMaxC : body.data.tempMaxC;
    if (!hasValidTemperatureRange(nextTempMinC, nextTempMaxC)) {
      res.status(400).json({
        error: "Set both product temperature limits and keep the minimum at or below the maximum.",
      });
      return;
    }
    const [updated] = await db
      .update(productsTable)
      .set(body.data)
      .where(
        and(
          eq(productsTable.id, params.data.productId),
          eq(productsTable.storeroomId, req.storeroomId!),
        ),
      )
      .returning({ id: productsTable.id });
    if (!updated) {
      res.status(404).json({ error: "Product not found." });
      return;
    }
    const product = await getProduct(req.storeroomId!, updated.id);
    res.json(UpdateProductResponse.parse(product));
  },
);

export default router;
