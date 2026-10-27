import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import {
  CreateStockCountBody,
  CreateStockCountResponse,
  DownloadStockCountWorkbookParams,
  GetStockCountParams,
  GetStockCountResponse,
  ListStockCountsResponse,
  RequestStockCountWorkbookUploadUrlBody,
  RequestStockCountWorkbookUploadUrlParams,
  RequestStockCountWorkbookUploadUrlResponse,
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
  stockMovementsTable,
  productsTable,
} from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";
import { ApiError } from "../lib/api-error";
import { applyInventoryDelta, listProducts } from "../lib/inventory";
import { ensureDefaultStockSection } from "../lib/catalogue-data";
import {
  InvalidWorkbookError,
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024;
const WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function safeWorkbookName(name: string): string {
  return name
    .replace(/[\\/]/g, "/")
    .split("/")
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
}

function workbookPathForCount(path: string, storeroomId: number, countId: number): boolean {
  const prefix = `/objects/count-workbooks/${storeroomId}/${countId}/`;
  return path.startsWith(prefix) && /^[a-f0-9-]{36}\.xlsx$/i.test(path.slice(prefix.length));
}

function workbookResponse(count: typeof stockCountsTable.$inferSelect) {
  return count.workbookObjectPath && count.workbookName &&
    count.workbookUploadedBy && count.workbookSubmittedAt
    ? {
        name: count.workbookName,
        uploadedBy: count.workbookUploadedBy,
        submittedAt: count.workbookSubmittedAt,
      }
    : null;
}

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
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const movements = productIds.length === 0
    ? []
    : await db
        .select({
          id: stockMovementsTable.id,
          productId: stockMovementsTable.productId,
          productName: productsTable.name,
          sectionId: stockMovementsTable.sectionId,
          sectionName: stockMovementsTable.sectionNameSnapshot,
          type: stockMovementsTable.type,
          quantityDelta: stockMovementsTable.quantityDelta,
          reason: stockMovementsTable.reason,
          actor: stockMovementsTable.actor,
          occurredAt: stockMovementsTable.occurredAt,
        })
        .from(stockMovementsTable)
        .innerJoin(productsTable, eq(productsTable.id, stockMovementsTable.productId))
        .where(and(
          eq(productsTable.storeroomId, storeroomId),
          inArray(stockMovementsTable.productId, productIds),
          gt(stockMovementsTable.occurredAt, count.createdAt),
        ))
        .orderBy(stockMovementsTable.occurredAt, stockMovementsTable.id);
  return { ...count, workbook: workbookResponse(count), lines, movements };
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
    workbook: workbookResponse(count),
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
    if (parsed.data.scope === "section" && !parsed.data.sectionId) {
      res.status(400).json({ error: "Choose a stock section for this count." });
      return;
    }

    await db.transaction((tx) =>
      ensureDefaultStockSection(tx, req.storeroomId!),
    );
    if (parsed.data.scope === "section") {
      const [section] = await db
        .select({ id: stockSectionsTable.id })
        .from(stockSectionsTable)
        .where(and(
          eq(stockSectionsTable.id, parsed.data.sectionId!),
          eq(stockSectionsTable.storeroomId, req.storeroomId!),
        ))
        .limit(1);
      if (!section) {
        res.status(400).json({ error: "Choose a stock section configured for this outlet." });
        return;
      }
    }
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
          : parsed.data.scope === "section"
            ? `section:${parsed.data.sectionId}`
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
      const sectionConditions = [eq(stockSectionsTable.storeroomId, req.storeroomId!)];
      if (parsed.data.scope === "section") {
        sectionConditions.push(eq(stockSectionsTable.id, parsed.data.sectionId!));
      }
      const sections = await tx
        .select({
          id: stockSectionsTable.id,
          name: stockSectionsTable.name,
        })
        .from(stockSectionsTable)
        .where(and(...sectionConditions))
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
  "/stock-counts/:countId/workbook/upload-url",
  requireRoles("owner", "admin", "supervisor", "staff"),
  async (req, res): Promise<void> => {
    const params = RequestStockCountWorkbookUploadUrlParams.safeParse(req.params);
    const body = RequestStockCountWorkbookUploadUrlBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Enter valid workbook details." });
      return;
    }

    const name = safeWorkbookName(body.data.name);
    if (
      !name.toLocaleLowerCase().endsWith(".xlsx") ||
      ![WORKBOOK_CONTENT_TYPE, "application/octet-stream"].includes(body.data.contentType)
    ) {
      res.status(400).json({ error: "Upload an .xlsx stock-count workbook." });
      return;
    }

    const [count] = await db
      .select({ id: stockCountsTable.id, status: stockCountsTable.status })
      .from(stockCountsTable)
      .where(and(
        eq(stockCountsTable.id, params.data.countId),
        eq(stockCountsTable.storeroomId, req.storeroomId!),
      ))
      .limit(1);
    if (!count) {
      res.status(404).json({ error: "Stock count not found." });
      return;
    }
    if (count.status !== "in_progress") {
      res.status(409).json({ error: "This stock count is already complete." });
      return;
    }

    try {
      const objectPath = objectStorage.createStockCountWorkbookPath(
        req.storeroomId!,
        count.id,
      );
      const uploadURL = await objectStorage.getUploadUrl(objectPath);
      res.json(RequestStockCountWorkbookUploadUrlResponse.parse({ uploadURL, objectPath }));
    } catch (error) {
      req.log.error({ err: error }, "Could not create a stock-count workbook upload URL");
      res.status(500).json({ error: "Could not prepare the workbook upload." });
    }
  },
);

router.get("/stock-counts/:countId/workbook", async (req, res): Promise<void> => {
  const params = DownloadStockCountWorkbookParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [count] = await db
    .select()
    .from(stockCountsTable)
    .where(and(
      eq(stockCountsTable.id, params.data.countId),
      eq(stockCountsTable.storeroomId, req.storeroomId!),
    ))
    .limit(1);
  if (!count?.workbookObjectPath || !count.workbookName) {
    res.status(404).json({ error: "Submitted workbook not found." });
    return;
  }

  try {
    const file = await objectStorage.getObjectEntityFile(count.workbookObjectPath);
    const response = await objectStorage.downloadObject(file);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const filename = safeWorkbookName(count.workbookName) || `count-${count.id}.xlsx`;
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="count-${count.id}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Submitted workbook not found." });
      return;
    }
    req.log.error({ err: error }, "Could not download the stock-count workbook");
    res.status(500).json({ error: "Could not download the submitted workbook." });
  }
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

    const workbookName = body.data.workbookName
      ? safeWorkbookName(body.data.workbookName)
      : undefined;
    if (Boolean(body.data.workbookObjectPath) !== Boolean(workbookName)) {
      res.status(400).json({ error: "Workbook name and uploaded file must be provided together." });
      return;
    }
    if (
      body.data.workbookObjectPath &&
      (!workbookName?.toLocaleLowerCase().endsWith(".xlsx") ||
        !workbookPathForCount(body.data.workbookObjectPath, req.storeroomId!, params.data.countId))
    ) {
      res.status(400).json({ error: "Workbook does not belong to this count session." });
      return;
    }
    if (body.data.workbookObjectPath) {
      try {
        const file = await objectStorage.getObjectEntityFile(body.data.workbookObjectPath);
        await objectStorage.getWorkbookMetadata(file);
      } catch (error) {
        if (error instanceof ObjectNotFoundError || error instanceof InvalidWorkbookError) {
          res.status(400).json({ error: "Uploaded workbook is missing or invalid. Upload it again." });
          return;
        }
        throw error;
      }
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
        const currentMovements = await tx
          .select({ id: stockMovementsTable.id })
          .from(stockMovementsTable)
          .innerJoin(productsTable, eq(productsTable.id, stockMovementsTable.productId))
          .where(and(
            eq(productsTable.storeroomId, req.storeroomId!),
            inArray(stockMovementsTable.productId, [...new Set(lines.map((line) => line.productId))]),
            gt(stockMovementsTable.occurredAt, count.createdAt),
          ));
        const acknowledgedMovementIds = new Set(body.data.acknowledgedMovementIds);
        if (currentMovements.some((movement) => !acknowledgedMovementIds.has(movement.id))) {
          throw new ApiError(
            409,
            "Stock movements changed since this review was loaded. Refresh the count, review the new movements, and confirm again.",
          );
        }
        const countLineKey = (productId: number, sectionId?: number) =>
          `${productId}:${sectionId ?? "outlet"}`;
        if (
          body.data.lines.length === 0 ||
          body.data.lines.length > lines.length ||
          new Set(
            body.data.lines.map((line) =>
              countLineKey(line.productId, line.sectionId),
            ),
          ).size !== body.data.lines.length
        ) {
          throw new ApiError(400, "Submit at least one counted product and storage area, without duplicate lines.");
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
          .set({
            status: "completed",
            completedAt: new Date(),
            ...(body.data.workbookObjectPath && workbookName
              ? {
                  workbookObjectPath: body.data.workbookObjectPath,
                  workbookName,
                  workbookUploadedByUserId: req.storeUser!.id,
                  workbookUploadedBy: req.storeUser!.name,
                  workbookSubmittedAt: new Date(),
                }
              : {}),
          })
          .where(
            and(
              eq(stockCountsTable.id, count.id),
              eq(stockCountsTable.storeroomId, req.storeroomId!),
            ),
          );
      });
    } catch (error) {
      if (body.data.workbookObjectPath) {
        try {
          await objectStorage.deleteObject(body.data.workbookObjectPath);
        } catch (cleanupError) {
          req.log.warn({ err: cleanupError }, "Could not remove an uncommitted count workbook");
        }
      }
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
