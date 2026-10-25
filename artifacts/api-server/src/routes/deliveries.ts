import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateDeliveryBody,
  CreateDeliveryResponse,
  DecideDeliveryBody,
  DecideDeliveryParams,
  DecideDeliveryResponse,
  ListDeliveriesResponse,
} from "@workspace/api-zod";
import {
  db,
  deliveriesTable,
  deliveryLinesTable,
  productCategoriesTable,
  productsTable,
  purchaseOrderLinesTable,
  purchaseOrdersTable,
  suppliersTable,
} from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";
import { ApiError } from "../lib/api-error";
import { applyInventoryDelta } from "../lib/inventory";

const router: IRouter = Router();

async function getDelivery(deliveryId: number, storeroomId: number) {
  const [delivery] = await db
    .select({
      id: deliveriesTable.id,
      status: deliveriesTable.status,
      supplierId: deliveriesTable.supplierId,
      supplierName: suppliersTable.name,
      purchaseOrderId: deliveriesTable.purchaseOrderId,
      recordedBy: deliveriesTable.recordedBy,
      decidedBy: deliveriesTable.decidedBy,
      decisionNote: deliveriesTable.decisionNote,
      createdAt: deliveriesTable.createdAt,
    })
    .from(deliveriesTable)
    .leftJoin(suppliersTable, eq(suppliersTable.id, deliveriesTable.supplierId))
    .where(and(
      eq(deliveriesTable.id, deliveryId),
      eq(deliveriesTable.storeroomId, storeroomId),
    ))
    .limit(1);
  if (!delivery) return null;
  const lines = await db
    .select({
      productId: deliveryLinesTable.productId,
      productName: deliveryLinesTable.productName,
      quantity: deliveryLinesTable.quantity,
      tempC: deliveryLinesTable.tempC,
      expiryDate: deliveryLinesTable.expiryDate,
      checkStatus: deliveryLinesTable.checkStatus,
      issue: deliveryLinesTable.issue,
    })
    .from(deliveryLinesTable)
    .where(eq(deliveryLinesTable.deliveryId, deliveryId));
  return { ...delivery, lines };
}

async function receiveLines(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  deliveryId: number,
  actor: string,
) {
  const lines = await tx
    .select()
    .from(deliveryLinesTable)
    .where(eq(deliveryLinesTable.deliveryId, deliveryId))
    .for("update");
  const [delivery] = await tx
    .select()
    .from(deliveriesTable)
    .where(eq(deliveriesTable.id, deliveryId))
    .for("update");
  if (!delivery) throw new ApiError(404, "Delivery not found.");

  for (const line of lines) {
    await applyInventoryDelta(tx, {
      productId: line.productId,
      productName: line.productName,
      quantityDelta: line.quantity,
      reason: `Delivery #${delivery.id}`,
      actor,
      type: "delivery",
      expiryDate: line.expiryDate,
    });
  }

  if (delivery.purchaseOrderId) {
    const orderLines = await tx
      .select()
      .from(purchaseOrderLinesTable)
      .where(eq(purchaseOrderLinesTable.orderId, delivery.purchaseOrderId))
      .for("update");
    for (const deliveryLine of lines) {
      let quantityLeft = deliveryLine.quantity;
      for (const orderLine of orderLines.filter((line) => line.productId === deliveryLine.productId)) {
        if (quantityLeft <= 0.001) break;
        const outstanding = Math.max(0, orderLine.quantity - orderLine.receivedQuantity);
        if (outstanding <= 0.001) continue;
        const applied = Math.min(outstanding, quantityLeft);
        const receivedQuantity = orderLine.receivedQuantity + applied;
        await tx
          .update(purchaseOrderLinesTable)
          .set({ receivedQuantity })
          .where(eq(purchaseOrderLinesTable.id, orderLine.id));
        orderLine.receivedQuantity = receivedQuantity;
        quantityLeft -= applied;
      }
    }
    const complete = orderLines.every((line) => line.receivedQuantity >= line.quantity - 0.001);
    await tx
      .update(purchaseOrdersTable)
      .set({ status: complete ? "received" : "partially_received", updatedAt: new Date() })
      .where(eq(purchaseOrdersTable.id, delivery.purchaseOrderId));
  }
}

router.get("/deliveries", async (req, res): Promise<void> => {
  const records = await db
    .select({ id: deliveriesTable.id })
    .from(deliveriesTable)
    .where(eq(deliveriesTable.storeroomId, req.storeroomId!))
    .orderBy(desc(deliveriesTable.createdAt))
    .limit(100);
  const deliveries = await Promise.all(records.map(({ id }) => getDelivery(id, req.storeroomId!)));
  res.json(ListDeliveriesResponse.parse(deliveries.filter(Boolean)));
});

router.post("/deliveries", async (req, res): Promise<void> => {
  const body = CreateDeliveryBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  try {
    const deliveryId = await db.transaction(async (tx) => {
      let orderLines: (typeof purchaseOrderLinesTable.$inferSelect)[] = [];
      let linkedSupplierId: number | null = null;
      if (body.data.purchaseOrderId) {
        const [order] = await tx
          .select()
          .from(purchaseOrdersTable)
          .where(and(
            eq(purchaseOrdersTable.id, body.data.purchaseOrderId),
            eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
          ))
          .for("update");
        if (!order) throw new ApiError(404, "Purchase request not found in this outlet.");
        if (!["approved", "partially_received"].includes(order.status)) {
          throw new ApiError(409, "Only approved requests can be checked against a delivery.");
        }
        linkedSupplierId = order.supplierId;
        orderLines = await tx
          .select()
          .from(purchaseOrderLinesTable)
          .where(eq(purchaseOrderLinesTable.orderId, order.id))
          .for("update");
      }
      const productIds = body.data.lines.map((line) => line.productId);
      if (new Set(productIds).size !== productIds.length) {
        throw new ApiError(400, "Add each product once per delivery and combine its quantity.");
      }
      const supplierId = body.data.supplierId ?? linkedSupplierId;
      if (linkedSupplierId && supplierId && linkedSupplierId !== supplierId) {
        throw new ApiError(400, "The selected supplier does not match the linked purchase request.");
      }
      if (supplierId) {
        const [supplier] = await tx
          .select()
          .from(suppliersTable)
          .where(and(
            eq(suppliersTable.id, supplierId),
            eq(suppliersTable.storeroomId, req.storeroomId!),
          ))
          .limit(1);
        if (!supplier || (!supplier.active && supplier.id !== linkedSupplierId)) {
          throw new ApiError(400, "Choose an active supplier from this outlet.");
        }
      }

      const productRecords: Array<
        typeof productsTable.$inferSelect & {
          receivingTempMinC: number | null;
          receivingTempMaxC: number | null;
          receivingHandlingSop: string;
        }
      > = [];
      for (const item of body.data.lines) {
        const [product] = await tx
          .select()
          .from(productsTable)
          .where(and(
            eq(productsTable.id, item.productId),
            eq(productsTable.storeroomId, req.storeroomId!),
            eq(productsTable.active, true),
          ))
          .limit(1);
        if (!product) throw new ApiError(400, `Product ${item.productId} is unavailable in this outlet.`);
        const [categoryRule] = await tx
          .select({
            receivingTempMinC: productCategoriesTable.receivingTempMinC,
            receivingTempMaxC: productCategoriesTable.receivingTempMaxC,
            receivingHandlingSop: productCategoriesTable.receivingHandlingSop,
          })
          .from(productCategoriesTable)
          .where(
            and(
              eq(productCategoriesTable.storeroomId, req.storeroomId!),
              eq(productCategoriesTable.key, product.category),
            ),
          )
          .limit(1);
        productRecords.push({
          ...product,
          receivingTempMinC: categoryRule?.receivingTempMinC ?? null,
          receivingTempMaxC: categoryRule?.receivingTempMaxC ?? null,
          receivingHandlingSop: categoryRule?.receivingHandlingSop ?? "",
        });
      }

      const remaining = new Map<number, number>();
      for (const line of orderLines) {
        remaining.set(
          line.productId,
          (remaining.get(line.productId) ?? 0) + Math.max(0, line.quantity - line.receivedQuantity),
        );
      }
      let needsReview = false;
      const checkedLines = body.data.lines.map((item, index) => {
        const product = productRecords[index];
        const issues: string[] = [];
        const hasProductRange = product.tempMinC !== null && product.tempMaxC !== null;
        const low = hasProductRange ? product.tempMinC : product.receivingTempMinC;
        const high = hasProductRange ? product.tempMaxC : product.receivingTempMaxC;
        const ruleSource = hasProductRange ? "product-specific" : "category";
        if (low !== null || high !== null) {
          if (item.tempC == null) issues.push(`Probe temperature is required by this ${ruleSource} receiving rule.`);
          else if ((low !== null && item.tempC < low) || (high !== null && item.tempC > high)) {
            issues.push(`Temperature ${item.tempC}°C is outside the allowed ${low}°C to ${high}°C range.`);
          }
        }
        if (body.data.purchaseOrderId) {
          const outstanding = remaining.get(item.productId);
          if (outstanding === undefined) {
            issues.push("This product is not on the linked purchase request.");
          } else if (item.quantity > outstanding + 0.001) {
            issues.push(`Quantity exceeds the ${outstanding} still outstanding on the request.`);
          }
          if (outstanding !== undefined) remaining.set(item.productId, Math.max(0, outstanding - item.quantity));
        }
        if (issues.length) needsReview = true;
        return {
          productId: product.id,
          productName: product.name,
          quantity: item.quantity,
          tempC: item.tempC ?? null,
          expiryDate: item.expiryDate?.toISOString().slice(0, 10) ?? null,
          checkStatus: issues.length ? "review" : "pass",
          issue: issues.join(" "),
        };
      });

      const [created] = await tx
        .insert(deliveriesTable)
        .values({
          storeroomId: req.storeroomId!,
          supplierId: supplierId ?? null,
          purchaseOrderId: body.data.purchaseOrderId ?? null,
          status: needsReview ? "pending_approval" : "accepted",
          recordedBy: req.storeUser!.name,
        })
        .returning({ id: deliveriesTable.id });
      await tx.insert(deliveryLinesTable).values(
        checkedLines.map((line) => ({
          ...line,
          deliveryId: created.id,
          issue: line.issue || null,
        })),
      );
      if (!needsReview) {
        await receiveLines(tx, created.id, req.storeUser!.name);
      }
      return created.id;
    });
    const delivery = await getDelivery(deliveryId, req.storeroomId!);
    res.status(201).json(CreateDeliveryResponse.parse(delivery));
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post(
  "/deliveries/:deliveryId/decision",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = DecideDeliveryParams.safeParse(req.params);
    const body = DecideDeliveryBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (body.data.decision !== "accepted" && !body.data.note?.trim()) {
      res.status(400).json({ error: "Add a note when rejecting or returning a delivery." });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        const [delivery] = await tx
          .select()
          .from(deliveriesTable)
          .where(and(
            eq(deliveriesTable.id, params.data.deliveryId),
            eq(deliveriesTable.storeroomId, req.storeroomId!),
          ))
          .for("update");
        if (!delivery) throw new ApiError(404, "Delivery not found.");
        if (delivery.status !== "pending_approval") {
          throw new ApiError(409, "Only deliveries waiting for review can receive a decision.");
        }
        if (body.data.decision === "accepted") {
          await receiveLines(tx, delivery.id, req.storeUser!.name);
        }
        await tx
          .update(deliveriesTable)
          .set({
            status: body.data.decision,
            decidedBy: req.storeUser!.name,
            decisionNote: body.data.note?.trim() || null,
            updatedAt: new Date(),
          })
          .where(eq(deliveriesTable.id, delivery.id));
      });
      const updated = await getDelivery(params.data.deliveryId, req.storeroomId!);
      res.json(DecideDeliveryResponse.parse(updated));
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
