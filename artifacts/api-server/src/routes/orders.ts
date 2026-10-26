import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreatePurchaseOrderBody,
  CreatePurchaseOrderResponse,
  CreateLowStockPurchaseOrderDraftsResponse,
  DecidePurchaseOrderBody,
  DecidePurchaseOrderParams,
  DecidePurchaseOrderResponse,
  UpdatePurchaseOrderDraftBody,
  UpdatePurchaseOrderDraftParams,
  UpdatePurchaseOrderDraftResponse,
  IssuePurchaseOrderParams,
  IssuePurchaseOrderResponse,
  CancelPurchaseOrderParams,
  CancelPurchaseOrderResponse,
  ListPurchaseOrdersQueryParams,
  ListPurchaseOrdersResponse,
  ReceivePurchaseOrderBody,
  ReceivePurchaseOrderParams,
  ReceivePurchaseOrderResponse,
} from "@workspace/api-zod";
import {
  db,
  productsTable,
  purchaseOrderLinesTable,
  purchaseOrdersTable,
  storeroomsTable,
  suppliersTable,
} from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";
import { ApiError } from "../lib/api-error";
import { applyInventoryDelta } from "../lib/inventory";
import { listProducts } from "../lib/inventory";

const router: IRouter = Router();

type PurchaseLineInput = {
  productId: number;
  quantity: number;
  unitType?: "unit" | "bundle";
};

function dateOnly(value: Date | string | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function monthlyPoPrefix(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "00";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  return `PO-${year}${month}`;
}

async function assignPoNumber(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  storeroomId: number,
) {
  const [lockedStoreroom] = await tx
    .select({ id: storeroomsTable.id })
    .from(storeroomsTable)
    .where(eq(storeroomsTable.id, storeroomId))
    .for("update")
    .limit(1);
  if (!lockedStoreroom) throw new Error("Cannot allocate a PO number for a missing outlet.");

  const prefix = monthlyPoPrefix();
  const existingNumbers = await tx
    .select({ orderNumber: purchaseOrdersTable.orderNumber })
    .from(purchaseOrdersTable)
    .where(and(
      eq(purchaseOrdersTable.storeroomId, storeroomId),
      like(purchaseOrdersTable.orderNumber, `${prefix}%`),
    ));
  const highestSequence = existingNumbers.reduce((highest, { orderNumber }) => {
    const suffix = orderNumber?.slice(prefix.length) ?? "";
    if (!/^\d+$/.test(suffix)) return highest;
    return Math.max(highest, Number(suffix));
  }, 0);
  return `${prefix}${String(highestSequence + 1).padStart(3, "0")}`;
}

async function buildOrderLines(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  storeroomId: number,
  orderId: number,
  lines: PurchaseLineInput[],
) {
  if (new Set(lines.map((line) => line.productId)).size !== lines.length) {
    throw new ApiError(400, "Add each product once per purchase order.");
  }
  const values = [];
  for (const line of lines) {
    const [product] = await tx
      .select()
      .from(productsTable)
      .where(and(
        eq(productsTable.id, line.productId),
        eq(productsTable.storeroomId, storeroomId),
        eq(productsTable.active, true),
      ))
      .for("share")
      .limit(1);
    if (!product) throw new ApiError(400, `Product ${line.productId} is unavailable.`);
    const unitType = line.unitType ?? "unit";
    const conversionFactor = unitType === "bundle" ? product.bundleSize : 1;
    const unit = unitType === "bundle" ? product.bundleUnit : product.unit;
    if (unitType === "bundle" && !unit.trim()) {
      throw new ApiError(400, `${product.name} needs a bundle unit before it can be ordered by bundle.`);
    }
    values.push({
      orderId,
      productId: product.id,
      productName: product.name,
      quantity: line.quantity,
      receivedQuantity: 0,
      unit,
      conversionFactor,
    });
  }
  return values;
}

async function getOrder(orderId: number, storeroomId: number) {
  const [order] = await db
    .select({
      id: purchaseOrdersTable.id,
      status: purchaseOrdersTable.status,
      requestedBy: purchaseOrdersTable.requestedBy,
      reviewedBy: purchaseOrdersTable.reviewedBy,
      orderNumber: purchaseOrdersTable.orderNumber,
      expectedDeliveryDate: purchaseOrdersTable.expectedDeliveryDate,
      issuedAt: purchaseOrdersTable.issuedAt,
      note: purchaseOrdersTable.note,
      supplierId: purchaseOrdersTable.supplierId,
      supplierName: suppliersTable.name,
      createdAt: purchaseOrdersTable.createdAt,
      outlet: {
        id: storeroomsTable.id,
        name: storeroomsTable.name,
        contactEmail: storeroomsTable.contactEmail,
        contactPhone: storeroomsTable.contactPhone,
        businessAddress: storeroomsTable.businessAddress,
      },
    })
    .from(purchaseOrdersTable)
    .leftJoin(suppliersTable, eq(suppliersTable.id, purchaseOrdersTable.supplierId))
    .innerJoin(storeroomsTable, eq(storeroomsTable.id, purchaseOrdersTable.storeroomId))
    .where(
      and(
        eq(purchaseOrdersTable.id, orderId),
        eq(purchaseOrdersTable.storeroomId, storeroomId),
      ),
    )
    .limit(1);
  if (!order) return null;
  const lines = await db
    .select({
      productId: purchaseOrderLinesTable.productId,
      productName: purchaseOrderLinesTable.productName,
      quantity: purchaseOrderLinesTable.quantity,
      receivedQuantity: purchaseOrderLinesTable.receivedQuantity,
      unit: purchaseOrderLinesTable.unit,
      conversionFactor: purchaseOrderLinesTable.conversionFactor,
    })
    .from(purchaseOrderLinesTable)
    .where(eq(purchaseOrderLinesTable.orderId, orderId));
  return { ...order, lines };
}

router.get("/purchase-orders", async (req, res): Promise<void> => {
  const parsed = ListPurchaseOrdersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const orders = await db
    .select({
      id: purchaseOrdersTable.id,
      status: purchaseOrdersTable.status,
      requestedBy: purchaseOrdersTable.requestedBy,
      reviewedBy: purchaseOrdersTable.reviewedBy,
      orderNumber: purchaseOrdersTable.orderNumber,
      expectedDeliveryDate: purchaseOrdersTable.expectedDeliveryDate,
      issuedAt: purchaseOrdersTable.issuedAt,
      note: purchaseOrdersTable.note,
      supplierId: purchaseOrdersTable.supplierId,
      supplierName: suppliersTable.name,
      createdAt: purchaseOrdersTable.createdAt,
      outlet: {
        id: storeroomsTable.id,
        name: storeroomsTable.name,
        contactEmail: storeroomsTable.contactEmail,
        contactPhone: storeroomsTable.contactPhone,
        businessAddress: storeroomsTable.businessAddress,
      },
    })
    .from(purchaseOrdersTable)
    .leftJoin(suppliersTable, eq(suppliersTable.id, purchaseOrdersTable.supplierId))
    .innerJoin(storeroomsTable, eq(storeroomsTable.id, purchaseOrdersTable.storeroomId))
    .where(
      parsed.data.status
        ? and(
            eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
            eq(purchaseOrdersTable.status, parsed.data.status),
          )
        : eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
    )
    .orderBy(desc(purchaseOrdersTable.createdAt))
    .limit(100);
  if (orders.length === 0) {
    res.json(ListPurchaseOrdersResponse.parse([]));
    return;
  }
  const lines = await db
    .select({
      orderId: purchaseOrderLinesTable.orderId,
      productId: purchaseOrderLinesTable.productId,
      productName: purchaseOrderLinesTable.productName,
      quantity: purchaseOrderLinesTable.quantity,
      receivedQuantity: purchaseOrderLinesTable.receivedQuantity,
      unit: purchaseOrderLinesTable.unit,
      conversionFactor: purchaseOrderLinesTable.conversionFactor,
    })
    .from(purchaseOrderLinesTable)
    .where(
      inArray(
        purchaseOrderLinesTable.orderId,
        orders.map((order) => order.id),
      ),
    );
  const response = orders.map((order) => ({
    ...order,
    lines: lines
      .filter((line) => line.orderId === order.id)
      .map(({ orderId: _orderId, ...line }) => line),
  }));
  res.json(ListPurchaseOrdersResponse.parse(response));
});

router.post(
  "/purchase-orders",
  async (req, res): Promise<void> => {
    const parsed = CreatePurchaseOrderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    if (parsed.data.supplierId) {
      const [supplier] = await db
        .select({ id: suppliersTable.id })
        .from(suppliersTable)
        .where(and(
          eq(suppliersTable.id, parsed.data.supplierId),
          eq(suppliersTable.storeroomId, req.storeroomId!),
          eq(suppliersTable.active, true),
        ))
        .limit(1);
      if (!supplier) {
        res.status(400).json({ error: "Choose an active supplier from this outlet." });
        return;
      }
    }
    try {
      const created = await db.transaction(async (tx) => {
        const [order] = await tx
          .insert(purchaseOrdersTable)
          .values({
            storeroomId: req.storeroomId!,
            status: "draft",
            requestedBy: req.storeUser!.name,
            note: parsed.data.note ?? null,
            supplierId: parsed.data.supplierId ?? null,
            expectedDeliveryDate: dateOnly(parsed.data.expectedDeliveryDate),
          })
          .returning();
        const lines = await buildOrderLines(
          tx,
          req.storeroomId!,
          order.id,
          parsed.data.lines,
        );
        await tx.insert(purchaseOrderLinesTable).values(lines);
        return order;
      });
      const order = await getOrder(created.id, req.storeroomId!);
      res.status(201).json(CreatePurchaseOrderResponse.parse(order));
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/purchase-orders/low-stock-drafts",
  async (req, res): Promise<void> => {
    const products = await listProducts(req.storeroomId!, { active: true });
    const openLines = await db
      .select({
        productId: purchaseOrderLinesTable.productId,
        quantity: purchaseOrderLinesTable.quantity,
        receivedQuantity: purchaseOrderLinesTable.receivedQuantity,
        conversionFactor: purchaseOrderLinesTable.conversionFactor,
      })
      .from(purchaseOrderLinesTable)
      .innerJoin(
        purchaseOrdersTable,
        eq(purchaseOrdersTable.id, purchaseOrderLinesTable.orderId),
      )
      .where(and(
        eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
        inArray(purchaseOrdersTable.status, [
          "draft",
          "issued",
          "partially_received",
          "pending",
          "approved",
        ]),
      ));
    const covered = new Map<number, number>();
    for (const line of openLines) {
      covered.set(
        line.productId,
        (covered.get(line.productId) ?? 0) +
          Math.max(0, line.quantity - line.receivedQuantity) * line.conversionFactor,
      );
    }

    const grouped = new Map<string, {
      supplierId: number | null;
      lines: PurchaseLineInput[];
    }>();
    for (const product of products) {
      const minimumBase =
        product.minStock *
        (product.minStockUnit === "bundle" ? product.bundleSize : 1);
      const deficit = minimumBase - product.stockOnHand - (covered.get(product.id) ?? 0);
      if (deficit <= 0.001) continue;
      const unitType = product.minStockUnit === "bundle" ? "bundle" : "unit";
      const quantity =
        unitType === "bundle"
          ? Math.ceil((deficit / product.bundleSize) * 100) / 100
          : Math.ceil(deficit * 100) / 100;
      const supplierId = product.preferredSupplierId ?? null;
      const key = supplierId === null ? "unassigned" : String(supplierId);
      const group = grouped.get(key) ?? { supplierId, lines: [] };
      group.lines.push({ productId: product.id, quantity, unitType });
      grouped.set(key, group);
    }
    if (grouped.size === 0) {
      res.status(201).json(CreateLowStockPurchaseOrderDraftsResponse.parse([]));
      return;
    }

    const createdIds = await db.transaction(async (tx) => {
      const ids: number[] = [];
      for (const group of grouped.values()) {
        const [order] = await tx
          .insert(purchaseOrdersTable)
          .values({
            storeroomId: req.storeroomId!,
            status: "draft",
            requestedBy: req.storeUser!.name,
            supplierId: group.supplierId,
            note: "Suggested from low-stock levels. Review quantities before issuing.",
          })
          .returning({ id: purchaseOrdersTable.id });
        const lines = await buildOrderLines(
          tx,
          req.storeroomId!,
          order.id,
          group.lines,
        );
        await tx.insert(purchaseOrderLinesTable).values(lines);
        ids.push(order.id);
      }
      return ids;
    });
    const drafts = await Promise.all(
      createdIds.map((id) => getOrder(id, req.storeroomId!)),
    );
    res.status(201).json(CreateLowStockPurchaseOrderDraftsResponse.parse(drafts));
  },
);

router.patch(
  "/purchase-orders/:orderId",
  async (req, res): Promise<void> => {
    const params = UpdatePurchaseOrderDraftParams.safeParse(req.params);
    const body = UpdatePurchaseOrderDraftBody.safeParse(req.body);
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
        const [order] = await tx
          .select()
          .from(purchaseOrdersTable)
          .where(and(
            eq(purchaseOrdersTable.id, params.data.orderId),
            eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
          ))
          .for("update");
        if (!order) throw new ApiError(404, "Purchase order not found.");
        if (order.status !== "draft") {
          throw new ApiError(409, "Only draft purchase orders can be edited.");
        }
        const isManager = ["owner", "admin", "supervisor"].includes(req.storeUser!.role);
        if (!isManager && order.requestedBy !== req.storeUser!.name) {
          throw new ApiError(403, "Only the draft creator or an outlet manager can edit this order.");
        }
        if (body.data.supplierId !== null) {
          const [supplier] = await tx
            .select({ id: suppliersTable.id })
            .from(suppliersTable)
            .where(and(
              eq(suppliersTable.id, body.data.supplierId),
              eq(suppliersTable.storeroomId, req.storeroomId!),
              eq(suppliersTable.active, true),
            ))
            .for("share")
            .limit(1);
          if (!supplier) throw new ApiError(400, "Choose an active supplier from this outlet.");
        }
        await tx
          .delete(purchaseOrderLinesTable)
          .where(eq(purchaseOrderLinesTable.orderId, order.id));
        const lines = await buildOrderLines(
          tx,
          req.storeroomId!,
          order.id,
          body.data.lines,
        );
        await tx.insert(purchaseOrderLinesTable).values(lines);
        await tx
          .update(purchaseOrdersTable)
          .set({
            supplierId: body.data.supplierId,
            expectedDeliveryDate: dateOnly(body.data.expectedDeliveryDate),
            note: body.data.note,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrdersTable.id, order.id));
      });
      const updated = await getOrder(params.data.orderId, req.storeroomId!);
      res.json(UpdatePurchaseOrderDraftResponse.parse(updated));
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/purchase-orders/:orderId/issue",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = IssuePurchaseOrderParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(purchaseOrdersTable)
          .where(and(
            eq(purchaseOrdersTable.id, params.data.orderId),
            eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
          ))
          .for("update");
        if (!order) throw new ApiError(404, "Purchase order not found.");
        if (order.status !== "draft") throw new ApiError(409, "Only a draft can be issued.");
        if (!order.supplierId) throw new ApiError(400, "Choose a supplier before issuing this order.");
        const [supplier] = await tx
          .select({ id: suppliersTable.id })
          .from(suppliersTable)
          .where(and(
            eq(suppliersTable.id, order.supplierId),
            eq(suppliersTable.storeroomId, req.storeroomId!),
            eq(suppliersTable.active, true),
          ))
          .for("share")
          .limit(1);
        if (!supplier) throw new ApiError(400, "Choose an active supplier before issuing this order.");
        const lines = await tx
          .select({ id: purchaseOrderLinesTable.id })
          .from(purchaseOrderLinesTable)
          .where(eq(purchaseOrderLinesTable.orderId, order.id));
        if (!lines.length) throw new ApiError(400, "Add at least one product before issuing this order.");
        const orderNumber = await assignPoNumber(tx, req.storeroomId!);
        await tx
          .update(purchaseOrdersTable)
          .set({
            status: "issued",
            orderNumber,
            issuedAt: new Date(),
            reviewedBy: req.storeUser!.name,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrdersTable.id, order.id));
      });
      const order = await getOrder(params.data.orderId, req.storeroomId!);
      res.json(IssuePurchaseOrderResponse.parse(order));
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/purchase-orders/:orderId/cancel",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = CancelPurchaseOrderParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const [updated] = await db
      .update(purchaseOrdersTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(
        eq(purchaseOrdersTable.id, params.data.orderId),
        eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
        inArray(purchaseOrdersTable.status, ["draft", "issued", "partially_received", "approved"]),
      ))
      .returning({ id: purchaseOrdersTable.id });
    if (!updated) {
      res.status(409).json({ error: "This purchase order cannot be cancelled." });
      return;
    }
    const order = await getOrder(updated.id, req.storeroomId!);
    res.json(CancelPurchaseOrderResponse.parse(order));
  },
);

router.post(
  "/purchase-orders/:orderId/decision",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = DecidePurchaseOrderParams.safeParse(req.params);
    const body = DecidePurchaseOrderBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const [order] = await db
      .select()
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.id, params.data.orderId),
          eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
        ),
      )
      .limit(1);
    if (!order) {
      res.status(404).json({ error: "Purchase request not found." });
      return;
    }
    if (order.status !== "pending") {
      res.status(409).json({ error: "Only pending requests can be reviewed." });
      return;
    }
    try {
      await db.transaction(async (tx) => {
        const [lockedOrder] = await tx
          .select()
          .from(purchaseOrdersTable)
          .where(and(
            eq(purchaseOrdersTable.id, order.id),
            eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
          ))
          .for("update");
        if (!lockedOrder || lockedOrder.status !== "pending") {
          throw new ApiError(409, "Only pending requests can be reviewed.");
        }
        const orderNumber =
          body.data.decision === "approved"
            ? await assignPoNumber(tx, req.storeroomId!)
            : lockedOrder.orderNumber;
        await tx
          .update(purchaseOrdersTable)
          .set({
            status: body.data.decision,
            orderNumber,
            issuedAt:
              body.data.decision === "approved"
                ? new Date()
                : lockedOrder.issuedAt,
            reviewedBy: req.storeUser!.name,
            note: body.data.note ?? lockedOrder.note,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrdersTable.id, lockedOrder.id));
      });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
    const updated = await getOrder(order.id, req.storeroomId!);
    res.json(DecidePurchaseOrderResponse.parse(updated));
  },
);

router.post(
  "/purchase-orders/:orderId/receipts",
  requireRoles("owner", "admin", "supervisor", "staff"),
  async (req, res): Promise<void> => {
    const params = ReceivePurchaseOrderParams.safeParse(req.params);
    const body = ReceivePurchaseOrderBody.safeParse(req.body);
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
        const [order] = await tx
          .select()
          .from(purchaseOrdersTable)
          .where(
            and(
              eq(purchaseOrdersTable.id, params.data.orderId),
              eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
            ),
          )
          .for("update");
        if (!order) throw new ApiError(404, "Purchase request not found.");
        if (!["issued", "approved", "partially_received"].includes(order.status)) {
          throw new ApiError(409, "Issue the purchase order before receiving stock.");
        }

        const orderLines = await tx
          .select()
          .from(purchaseOrderLinesTable)
          .where(eq(purchaseOrderLinesTable.orderId, order.id))
          .for("update");
        let totalReceived = 0;
        for (const receiptLine of body.data.lines) {
          const line = orderLines.find(
            (candidate) => candidate.productId === receiptLine.productId,
          );
          if (!line) {
            throw new ApiError(400, `Product ${receiptLine.productId} is not on this request.`);
          }
          const outstanding = line.quantity - line.receivedQuantity;
          if (receiptLine.receivedQuantity > outstanding + 0.001) {
            throw new ApiError(400, `Received quantity exceeds the outstanding amount for ${line.productName}.`);
          }
          if (receiptLine.receivedQuantity <= 0) continue;
          totalReceived += receiptLine.receivedQuantity;
          await applyInventoryDelta(tx, {
            productId: line.productId,
            productName: line.productName,
            quantityDelta: receiptLine.receivedQuantity * line.conversionFactor,
            reason: `${order.orderNumber ?? `Purchase order #${order.id}`}${body.data.note ? ` — ${body.data.note}` : ""}`,
            actor: req.storeUser!.name,
            type: "received",
            expiryDate: receiptLine.expiryDate
              ? receiptLine.expiryDate.toISOString().slice(0, 10)
              : null,
            sectionId: receiptLine.sectionId ?? null,
          });
          await tx
            .update(purchaseOrderLinesTable)
            .set({
              receivedQuantity:
                line.receivedQuantity + receiptLine.receivedQuantity,
            })
            .where(eq(purchaseOrderLinesTable.id, line.id));
          line.receivedQuantity += receiptLine.receivedQuantity;
        }
        if (totalReceived <= 0) {
          throw new ApiError(400, "Enter at least one received quantity.");
        }
        const complete = orderLines.every(
          (line) => line.receivedQuantity >= line.quantity - 0.001,
        );
        await tx
          .update(purchaseOrdersTable)
          .set({
            status: complete ? "received" : "partially_received",
            note: body.data.note ?? order.note,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrdersTable.id, order.id));
      });
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }

    const updated = await getOrder(params.data.orderId, req.storeroomId!);
    res.json(ReceivePurchaseOrderResponse.parse(updated));
  },
);

export default router;
