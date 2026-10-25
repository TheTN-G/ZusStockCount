import { and, eq, gt, gte, lte, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { GetDashboardSummaryResponse } from "@workspace/api-zod";
import {
  db,
  deliveriesTable,
  productsTable,
  purchaseOrdersTable,
  stockBatchesTable,
} from "@workspace/db";
import { listMovements, listProducts } from "../lib/inventory";

const router: IRouter = Router();

router.get("/dashboard/summary", async (req, res): Promise<void> => {
  const products = await listProducts(req.storeroomId!, { active: true });
  const today = new Date().toISOString().slice(0, 10);
  const expiryEnd = new Date(`${today}T00:00:00.000Z`);
  expiryEnd.setUTCDate(expiryEnd.getUTCDate() + 7);
  const lastExpiryDay = expiryEnd.toISOString().slice(0, 10);
  const [expiryResult, pendingResult, pendingDeliveryResult] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockBatchesTable)
      .innerJoin(
        productsTable,
        eq(productsTable.id, stockBatchesTable.productId),
      )
      .where(
        and(
          eq(productsTable.storeroomId, req.storeroomId!),
          gt(stockBatchesTable.quantity, 0),
          gte(stockBatchesTable.expiryDate, today),
          lte(stockBatchesTable.expiryDate, lastExpiryDay),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(purchaseOrdersTable)
      .where(
        and(
          eq(purchaseOrdersTable.storeroomId, req.storeroomId!),
          eq(purchaseOrdersTable.status, "pending"),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(deliveriesTable)
      .where(
        and(
          eq(deliveriesTable.storeroomId, req.storeroomId!),
          eq(deliveriesTable.status, "pending_approval"),
        ),
      ),
  ]);
  const recentMovements = await listMovements(req.storeroomId!, { limit: 6 });
  res.json(
    GetDashboardSummaryResponse.parse({
      productCount: products.length,
      lowStockCount: products.filter((product) => product.lowStock).length,
      expiringSoonCount: expiryResult[0]?.count ?? 0,
      pendingApprovals:
        (pendingResult[0]?.count ?? 0) + (pendingDeliveryResult[0]?.count ?? 0),
      recentMovements,
    }),
  );
});

export default router;
