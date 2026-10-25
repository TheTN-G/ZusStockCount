import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateStockCountBody,
  CreateStockCountResponse,
  GetStockCountParams,
  GetStockCountResponse,
  ListStockCountsResponse,
  SubmitStockCountBody,
  SubmitStockCountParams,
  SubmitStockCountResponse,
} from "@workspace/api-zod";
import {
  db,
  stockSectionsTable,
  stockCountLinesTable,
  stockCountsTable,
  stockBatchesTable,
} from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";
import { ApiError } from "../lib/api-error";
import { applyInventoryDelta, listProducts } from "../lib/inventory";
import { ensureDefaultStockSection } from "../lib/catalogue-data";

const router: IRouter = Router();

async function getCount(countId: number, storeroomId: number) {
  const [count] = await db
    .select()
    .from(stockCountsTable)
    .where(
      and(
        eq(stockCountsTable.id, countId),
        eq(stockCountsTable.storeroomId, storeroomId),
      ),
    )
    .limit(1);
  if (!count) return null;
  const lines = await db
    .select({
      id: stockCountLinesTable.id,
      productId: stockCountLinesTable.productId,
      productName: stockCountLinesTable.productName,
      expectedQuantity: stockCountLinesTable.expectedQuantity,
      countedQuantity: stockCountLinesTable.countedQuantity,
      unit: stockCountLinesTable.unit,
      sectionId: stockCountLinesTable.sectionId,
      sectionName: stockCountLinesTable.sectionNameSnapshot,
    })
    .from(stockCountLinesTable)
    .where(eq(stockCountLinesTable.countId, countId))
    .orderBy(stockCountLinesTable.productName, stockCountLinesTable.sectionNameSnapshot);
  return { ...count, lines };
}

async function getCounts(storeroomId: number) {
  const counts = await db
    .select()
    .from(stockCountsTable)
    .where(eq(stockCountsTable.storeroomId, storeroomId))
    .orderBy(desc(stockCountsTable.createdAt))
    .limit(50);
  if (counts.length === 0) return [];
  const lines = await db
    .select({
      id: stockCountLinesTable.id,
      countId: stockCountLinesTable.countId,
      productId: stockCountLinesTable.productId,
      productName: stockCountLinesTable.productName,
      expectedQuantity: stockCountLinesTable.expectedQuantity,
      countedQuantity: stockCountLinesTable.countedQuantity,
      unit: stockCountLinesTable.unit,
      sectionId: stockCountLinesTable.sectionId,
      sectionName: stockCountLinesTable.sectionNameSnapshot,
    })
    .from(stockCountLinesTable)
    .where(inArray(stockCountLinesTable.countId, counts.map((count) => count.id)));
  return counts.map((count) => ({
    ...count,
    lines: lines
      .filter((line) => line.countId === count.id)
      .map(({ countId: _countId, ...line }) => line),
  }));
}

router.get("/stock-counts", async (req, res): Promise<void> => {
  res.json(ListStockCountsResponse.parse(await getCounts(req.storeroomId!)));
});

router.post(
  "/stock-counts",
  requireRoles("owner", "admin", "supervisor", "staff"),
  async (req, res): Promise<void> => {
    const parsed = CreateStockCountBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    if (parsed.data.scope === "category" && !parsed.data.category) {
      res.status(400).json({ error: "Choose a category for this count." });
      return;
    }
    if (parsed.data.scope === "product" && !parsed.data.productId) {
      res.status(400).json({ error: "Choose a product for this count." });
      return;
    }

    await db.transaction((tx) =>
      ensureDefaultStockSection(tx, req.storeroomId!),
    );
    let products = await listProducts(req.storeroomId!, { active: true });
    if (parsed.data.scope === "category") {
      products = products.filter(
        (product) => product.category === parsed.data.category,
      );
    } else if (parsed.data.scope === "product") {
      products = products.filter(
        (product) => product.id === parsed.data.productId,
      );
    }
    if (products.length === 0) {
      res.status(400).json({ error: "There are no active products in this count." });
      return;
    }

    const scope =
      parsed.data.scope === "category"
        ? `category:${parsed.data.category}`
        : parsed.data.scope === "product"
          ? `product:${parsed.data.productId}`
          : "all";
    const [created] = await db.transaction(async (tx) => {
      const [count] = await tx
        .insert(stockCountsTable)
        .values({
          storeroomId: req.storeroomId!,
          scope,
          createdBy: req.storeUser!.name,
        })
        .returning();
      const sections = await tx
        .select({
          id: stockSectionsTable.id,
          name: stockSectionsTable.name,
        })
        .from(stockSectionsTable)
        .where(eq(stockSectionsTable.storeroomId, req.storeroomId!))
        .orderBy(stockSectionsTable.name)
        .for("share");
      const balances = await tx
        .select({
          productId: stockBatchesTable.productId,
          sectionId: stockBatchesTable.sectionId,
          quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
        })
        .from(stockBatchesTable)
        .where(inArray(stockBatchesTable.productId, products.map((product) => product.id)))
        .groupBy(stockBatchesTable.productId, stockBatchesTable.sectionId);
      const balanceByKey = new Map(
        balances.map((balance) => [`${balance.productId}:${balance.sectionId}`, balance.quantity]),
      );
      const countLines = products.flatMap((product) =>
        sections.map((section) => ({
          countId: count.id,
          productId: product.id,
          productName: product.name,
          sectionId: section.id,
          sectionNameSnapshot: section.name,
          expectedQuantity: balanceByKey.get(`${product.id}:${section.id}`) ?? 0,
          countedQuantity: null,
          unit: product.unit,
        })),
      );
      await tx.insert(stockCountLinesTable).values(countLines);
      return [count];
    });
    const response = await getCount(created.id, req.storeroomId!);
    res.status(201).json(CreateStockCountResponse.parse(response));
  },
);

router.get("/stock-counts/:countId", async (req, res): Promise<void> => {
  const params = GetStockCountParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const count = await getCount(params.data.countId, req.storeroomId!);
  if (!count) {
    res.status(404).json({ error: "Stock count not found." });
    return;
  }
  res.json(GetStockCountResponse.parse(count));
});

router.post(
  "/stock-counts/:countId/submit",
  requireRoles("owner", "admin", "supervisor", "staff"),
  async (req, res): Promise<void> => {
    const params = SubmitStockCountParams.safeParse(req.params);
    const body = SubmitStockCountBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    try {
      await db.transaction(async (tx) => {
        const [count] = await tx
          .select()
          .from(stockCountsTable)
          .where(
            and(
              eq(stockCountsTable.id, params.data.countId),
              eq(stockCountsTable.storeroomId, req.storeroomId!),
            ),
          )
          .for("update");
        if (!count) throw new ApiError(404, "Stock count not found.");
        if (count.status !== "in_progress") {
          throw new ApiError(409, "This stock count is already complete.");
        }

        const lines = await tx
          .select()
          .from(stockCountLinesTable)
          .where(eq(stockCountLinesTable.countId, count.id))
          .for("update");
        const countLineKey = (productId: number, sectionId?: number) =>
          `${productId}:${sectionId ?? "outlet"}`;
        if (
          body.data.lines.length !== lines.length ||
          new Set(
            body.data.lines.map((line) =>
              countLineKey(line.productId, line.sectionId),
            ),
          ).size !== lines.length
        ) {
          throw new ApiError(400, "Enter a quantity for every product and storage area in this count.");
        }

        for (const counted of body.data.lines) {
          const line = lines.find(
            (candidate) =>
              candidate.productId === counted.productId &&
              (candidate.sectionId ?? undefined) === counted.sectionId,
          );
          if (!line) {
            throw new ApiError(400, `Product ${counted.productId} and storage area are not part of this count.`);
          }
          const stockConditions = [eq(stockBatchesTable.productId, line.productId)];
          if (line.sectionId !== null) {
            stockConditions.push(eq(stockBatchesTable.sectionId, line.sectionId));
          }
          const [stock] = await tx
            .select({
              quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
            })
            .from(stockBatchesTable)
            .where(and(...stockConditions));
          const currentQuantity = stock?.quantity ?? 0;
          const delta = counted.countedQuantity - currentQuantity;
          await applyInventoryDelta(tx, {
            productId: line.productId,
            productName: line.productName,
            quantityDelta: delta,
            reason: `Stock count #${count.id}`,
            actor: req.storeUser!.name,
            type: "count",
            sectionId: line.sectionId,
          });
          await tx
            .update(stockCountLinesTable)
            .set({ countedQuantity: counted.countedQuantity })
            .where(eq(stockCountLinesTable.id, line.id));
        }
        await tx
          .update(stockCountsTable)
          .set({ status: "completed", completedAt: new Date() })
          .where(
            and(
              eq(stockCountsTable.id, count.id),
              eq(stockCountsTable.storeroomId, req.storeroomId!),
            ),
          );
      });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    const updated = await getCount(params.data.countId, req.storeroomId!);
    res.json(SubmitStockCountResponse.parse(updated));
  },
);

export default router;
