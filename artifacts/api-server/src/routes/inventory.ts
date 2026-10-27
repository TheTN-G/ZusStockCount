import { Router, type IRouter } from "express";
import {
  CreateStockAdjustmentBody,
  CreateStockAdjustmentResponse,
  ListStockMovementsQueryParams,
  ListStockMovementsResponse,
  ListStockBatchesQueryParams,
  ListStockBatchesResponse,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";
import { ApiError } from "../lib/api-error";
import {
  applyInventoryDelta,
  getProduct,
  listBatches,
  listMovements,
} from "../lib/inventory";

const router: IRouter = Router();

router.get("/inventory/batches", async (req, res): Promise<void> => {
  const parsed = ListStockBatchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const batches = await listBatches(req.storeroomId!, parsed.data);
  res.json(ListStockBatchesResponse.parse(batches));
});

router.get("/inventory/movements", async (req, res): Promise<void> => {
  const parsed = ListStockMovementsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const dateFrom = parsed.data.dateFrom ? new Date(parsed.data.dateFrom) : undefined;
  const dateTo = parsed.data.dateTo ? new Date(parsed.data.dateTo) : undefined;
  if (
    (dateFrom && !Number.isFinite(dateFrom.getTime())) ||
    (dateTo && !Number.isFinite(dateTo.getTime()))
  ) {
    res.status(400).json({ error: "Activity date filters must be valid ISO 8601 timestamps." });
    return;
  }
  if (
    dateFrom &&
    dateTo &&
    dateFrom >= dateTo
  ) {
    res.status(400).json({ error: "The start date must be on or before the end date." });
    return;
  }
  const movements = await listMovements(req.storeroomId!, parsed.data);
  res.json(ListStockMovementsResponse.parse(movements));
});

router.post(
  "/inventory/adjustments",
  requireRoles("owner", "admin", "supervisor", "staff"),
  async (req, res): Promise<void> => {
    const parsed = CreateStockAdjustmentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const product = await getProduct(req.storeroomId!, parsed.data.productId);
    if (!product) {
      res.status(404).json({ error: "Product not found." });
      return;
    }
    try {
      const movement = await db.transaction(async (tx) =>
        applyInventoryDelta(tx, {
          productId: product.id,
          productName: product.name,
          quantityDelta: parsed.data.quantityDelta,
          reason: parsed.data.reason,
          actor: req.storeUser!.name,
          type:
            parsed.data.quantityDelta > 0 && /delivery/i.test(parsed.data.reason)
              ? "delivery"
              : "adjustment",
          sectionId: parsed.data.sectionId,
          expiryDate: parsed.data.expiryDate
            ? parsed.data.expiryDate.toISOString().slice(0, 10)
            : null,
        }),
      );
      if (!movement) {
        res.status(400).json({ error: "Quantity change must not be zero." });
        return;
      }
      res.status(201).json(CreateStockAdjustmentResponse.parse(movement));
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

export default router;
