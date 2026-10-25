import { and, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreatePurchaseOrderBody,
  CreatePurchaseOrderResponse,
  DecidePurchaseOrderBody,
  DecidePurchaseOrderParams,
  DecidePurchaseOrderResponse,
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

const router: IRouter = Router();

async function getOrder(orderId: number, storeroomId: number) {
  const [order] = await db
    .select({
      id: purchaseOrdersTable.id,
      status: purchaseOrdersTable.status,
      requestedBy: purchaseOrdersTable.requestedBy,
      reviewedBy: purchaseOrdersTable.reviewedBy,
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

    const products: {
      id: number;
      name: string;
      unit: string;
      quantity: number;
    }[] = [];
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
    for (const line of parsed.data.lines) {
      const [product] = await db
        .select()
        .from(productsTable)
        .where(
          and(
            eq(productsTable.id, line.productId),
            eq(productsTable.active, true),
            eq(productsTable.storeroomId, req.storeroomId!),
          ),
        )
        .limit(1);
      if (!product) {
        res.status(400).json({ error: `Product ${line.productId} is unavailable.` });
        return;
      }
      products.push({ ...product, quantity: line.quantity });
    }

    const created = await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(purchaseOrdersTable)
        .values({
          storeroomId: req.storeroomId!,
          requestedBy: req.storeUser!.name,
          note: parsed.data.note ?? null,
          supplierId: parsed.data.supplierId ?? null,
        })
        .returning();
      await tx.insert(purchaseOrderLinesTable).values(
        products.map((product) => ({
          orderId: order.id,
          productId: product.id,
          productName: product.name,
          quantity: product.quantity,
          receivedQuantity: 0,
          unit: product.unit,
        })),
      );
      return order;
    });
    const order = await getOrder(created.id, req.storeroomId!);
    res.status(201).json(CreatePurchaseOrderResponse.parse(order));
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
    await db
      .update(purchaseOrdersTable)
      .set({
        status: body.data.decision,
        reviewedBy: req.storeUser!.name,
        note: body.data.note ?? order.note,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrdersTable.id, order.id));
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
        if (!["approved", "partially_received"].includes(order.status)) {
          throw new ApiError(409, "Approve the request before receiving stock.");
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
            quantityDelta: receiptLine.receivedQuantity,
            reason: `Purchase request #${order.id}${body.data.note ? ` — ${body.data.note}` : ""}`,
            actor: req.storeUser!.name,
            type: "received",
            expiryDate: receiptLine.expiryDate
              ? receiptLine.expiryDate.toISOString().slice(0, 10)
              : null,
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
