import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateStockTransferBody,
  CreateStockTransferResponse,
  GetStockTransferOptionsQueryParams,
  GetStockTransferOptionsResponse,
  ListStockTransfersQueryParams,
  ListStockTransfersResponse,
} from "@workspace/api-zod";
import {
  db,
  productsTable,
  stockBatchesTable,
  stockMovementsTable,
  stockSectionsTable,
  stockTransfersTable,
  storeroomMembershipsTable,
  storeroomsTable,
} from "@workspace/db";
import { ApiError } from "../lib/api-error";
import { ensureDefaultStockSection } from "../lib/catalogue-data";
import { requireRoles } from "../middlewares/storeUser";

const router: IRouter = Router();
const transferRoles = ["owner", "admin", "supervisor"];
const epsilon = 0.001;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function transferHash(input: {
  destinationOutletId: number;
  productId: number;
  destinationProductId: number;
  sourceSectionId: number;
  destinationSectionId: number;
  quantity: number;
  expectedSourceQuantity: number;
  expectedDestinationQuantity: number;
  note?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.destinationOutletId,
        input.productId,
        input.destinationProductId,
        input.sourceSectionId,
        input.destinationSectionId,
        input.quantity,
        input.expectedSourceQuantity,
        input.expectedDestinationQuantity,
        input.note?.trim() ?? "",
      ]),
    )
    .digest("hex");
}

async function stockTotal(tx: Transaction, productId: number): Promise<number> {
  const [row] = await tx
    .select({
      quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
    })
    .from(stockBatchesTable)
    .where(eq(stockBatchesTable.productId, productId));
  return row?.quantity ?? 0;
}

async function sectionBalances(
  tx: Transaction,
  storeroomId: number,
  productId: number,
) {
  return tx
    .select({
      id: stockSectionsTable.id,
      name: stockSectionsTable.name,
      quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
    })
    .from(stockSectionsTable)
    .leftJoin(
      stockBatchesTable,
      and(
        eq(stockBatchesTable.sectionId, stockSectionsTable.id),
        eq(stockBatchesTable.productId, productId),
      ),
    )
    .where(eq(stockSectionsTable.storeroomId, storeroomId))
    .groupBy(stockSectionsTable.id)
    .orderBy(stockSectionsTable.name);
}

async function canAccessOutlet(
  tx: Transaction,
  userId: string,
  workspaceId: number,
  outletId: number,
) {
  const [access] = await tx
    .select({
      outlet: storeroomsTable,
      membership: storeroomMembershipsTable,
    })
    .from(storeroomMembershipsTable)
    .innerJoin(
      storeroomsTable,
      eq(storeroomsTable.id, storeroomMembershipsTable.storeroomId),
    )
    .where(
      and(
        eq(storeroomMembershipsTable.userId, userId),
        eq(storeroomsTable.id, outletId),
        eq(storeroomsTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return access ?? null;
}

router.get("/stock-transfers/options", async (req, res): Promise<void> => {
  const query = GetStockTransferOptionsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  if (!transferRoles.includes(req.storeMembership!.role)) {
    res.status(403).json({ error: "You do not have permission to prepare stock transfers." });
    return;
  }
  try {
    const options = await db.transaction(async (tx) => {
      const destinationAccess = await canAccessOutlet(
        tx,
        req.storeUser!.id,
        req.workspaceId!,
        query.data.destinationOutletId,
      );
      if (!destinationAccess) {
        throw new ApiError(404, "Destination outlet is not available in this workspace.");
      }
      if (!transferRoles.includes(destinationAccess.membership.role)) {
        throw new ApiError(403, "You need manager access at both outlets to view transfer stock options.");
      }
      await ensureDefaultStockSection(tx, req.storeroomId!);
      await ensureDefaultStockSection(tx, query.data.destinationOutletId);

      const [sourceProduct] = await tx
        .select()
        .from(productsTable)
        .where(
          and(
            eq(productsTable.id, query.data.productId),
            eq(productsTable.storeroomId, req.storeroomId!),
            eq(productsTable.active, true),
          ),
        )
        .limit(1);
      if (!sourceProduct) throw new ApiError(404, "Source product not found in this outlet.");

      const sourceSections = await sectionBalances(
        tx,
        req.storeroomId!,
        sourceProduct.id,
      );
      const destinationProducts = await tx
        .select({
          id: productsTable.id,
          name: productsTable.name,
          unit: productsTable.unit,
          bundleSize: productsTable.bundleSize,
        })
        .from(productsTable)
        .where(
          and(
            eq(productsTable.storeroomId, query.data.destinationOutletId),
            eq(productsTable.active, true),
            sql`lower(${productsTable.unit}) = lower(${sourceProduct.unit})`,
            eq(productsTable.bundleSize, sourceProduct.bundleSize),
          ),
        )
        .orderBy(productsTable.name);
      const destinationChoices = [];
      for (const product of destinationProducts) {
        destinationChoices.push({
          ...product,
          sections: await sectionBalances(
            tx,
            query.data.destinationOutletId,
            product.id,
          ),
        });
      }
      return {
        sourceOutlet: {
          id: req.storeroom!.id,
          name: req.storeroom!.name,
        },
        destinationOutlet: {
          id: destinationAccess.outlet.id,
          name: destinationAccess.outlet.name,
        },
        sourceProduct: {
          id: sourceProduct.id,
          name: sourceProduct.name,
          unit: sourceProduct.unit,
          bundleSize: sourceProduct.bundleSize,
          sections: sourceSections,
        },
        sourceSections,
        destinationProducts: destinationChoices,
      };
    });
    res.json(GetStockTransferOptionsResponse.parse(options));
  } catch (error) {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.get("/stock-transfers", async (req, res): Promise<void> => {
  const query = ListStockTransfersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const transfers = await db
    .select()
    .from(stockTransfersTable)
    .where(
      or(
        eq(stockTransfersTable.sourceStoreroomId, req.storeroomId!),
        eq(stockTransfersTable.destinationStoreroomId, req.storeroomId!),
      ),
    )
    .orderBy(desc(stockTransfersTable.occurredAt), desc(stockTransfersTable.id))
    .limit(query.data.limit ?? 100);
  res.json(ListStockTransfersResponse.parse(transfers));
});

router.post(
  "/stock-transfers",
  requireRoles(...transferRoles),
  async (req, res): Promise<void> => {
    const body = CreateStockTransferBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (
      !transferRoles.includes(req.storeMembership!.role) ||
      body.data.quantity <= 0 ||
      !Number.isFinite(body.data.quantity)
    ) {
      res.status(403).json({ error: "You do not have permission to transfer stock." });
      return;
    }
    if (Math.abs(body.data.quantity * 100 - Math.round(body.data.quantity * 100)) > 1e-7) {
      res.status(400).json({ error: "Transfer quantity can have up to two decimal places." });
      return;
    }
    const hash = transferHash(body.data);

    try {
      const transfer = await db.transaction(async (tx) => {
        const [previous] = await tx
          .select()
          .from(stockTransfersTable)
          .where(eq(stockTransfersTable.clientKey, body.data.clientKey))
          .for("update")
          .limit(1);
        if (previous) {
          if (previous.requestHash !== hash) {
            throw new ApiError(409, "This transfer attempt was already used with different details.");
          }
          return previous;
        }

        const destinationAccess = await canAccessOutlet(
          tx,
          req.storeUser!.id,
          req.workspaceId!,
          body.data.destinationOutletId,
        );
        if (!destinationAccess) {
          throw new ApiError(404, "Destination outlet is not available in this workspace.");
        }
        if (!transferRoles.includes(destinationAccess.membership.role)) {
          throw new ApiError(403, "You need manager access at both outlets to transfer stock.");
        }

        await ensureDefaultStockSection(tx, req.storeroomId!);
        await ensureDefaultStockSection(tx, body.data.destinationOutletId);

        const productIds = [...new Set([body.data.productId, body.data.destinationProductId])].sort((a, b) => a - b);
        const lockedProducts = await tx
          .select()
          .from(productsTable)
          .where(inArray(productsTable.id, productIds))
          .orderBy(asc(productsTable.id))
          .for("update");
        const [afterLockRetry] = await tx
          .select()
          .from(stockTransfersTable)
          .where(eq(stockTransfersTable.clientKey, body.data.clientKey))
          .limit(1);
        if (afterLockRetry) {
          if (afterLockRetry.requestHash !== hash) {
            throw new ApiError(409, "This transfer attempt was already used with different details.");
          }
          return afterLockRetry;
        }
        const sourceProduct = lockedProducts.find(
          (product) =>
            product.id === body.data.productId &&
            product.storeroomId === req.storeroomId &&
            product.active,
        );
        const destinationProduct = lockedProducts.find(
          (product) =>
            product.id === body.data.destinationProductId &&
            product.storeroomId === body.data.destinationOutletId &&
            product.active,
        );
        if (!sourceProduct || !destinationProduct) {
          throw new ApiError(404, "Choose active products from the selected outlets.");
        }
        if (
          sourceProduct.unit.trim().toLowerCase() !== destinationProduct.unit.trim().toLowerCase() ||
          sourceProduct.bundleSize !== destinationProduct.bundleSize
        ) {
          throw new ApiError(400, "The destination product must use the same unit and bundle size.");
        }
        if (
          body.data.destinationOutletId === req.storeroomId &&
          sourceProduct.id !== destinationProduct.id
        ) {
          throw new ApiError(400, "Within one outlet, select the same product at both ends.");
        }

        const [sourceSection] = await tx
          .select()
          .from(stockSectionsTable)
          .where(
            and(
              eq(stockSectionsTable.id, body.data.sourceSectionId),
              eq(stockSectionsTable.storeroomId, req.storeroomId!),
            ),
          )
          .for("update")
          .limit(1);
        const [destinationSection] = await tx
          .select()
          .from(stockSectionsTable)
          .where(
            and(
              eq(stockSectionsTable.id, body.data.destinationSectionId),
              eq(stockSectionsTable.storeroomId, body.data.destinationOutletId),
            ),
          )
          .for("update")
          .limit(1);
        if (!sourceSection || !destinationSection) {
          throw new ApiError(404, "Choose storage areas from the selected outlets.");
        }
        if (
          sourceSection.id === destinationSection.id &&
          body.data.destinationOutletId === req.storeroomId
        ) {
          throw new ApiError(400, "Choose two different storage areas.");
        }

        const sourceBatches = await tx
          .select()
          .from(stockBatchesTable)
          .where(
            and(
              eq(stockBatchesTable.productId, sourceProduct.id),
              eq(stockBatchesTable.sectionId, sourceSection.id),
            ),
          )
          .orderBy(
            asc(sql`${stockBatchesTable.expiryDate} is null`),
            asc(stockBatchesTable.expiryDate),
            asc(stockBatchesTable.receivedAt),
            asc(stockBatchesTable.id),
          )
          .for("update");
        const sourceBefore = sourceBatches.reduce(
          (total, batch) => total + batch.quantity,
          0,
        );
        const destinationBefore = await tx
          .select({
            quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
          })
          .from(stockBatchesTable)
          .where(
            and(
              eq(stockBatchesTable.productId, destinationProduct.id),
              eq(stockBatchesTable.sectionId, destinationSection.id),
            ),
          );
        const destinationSectionBefore = destinationBefore[0]?.quantity ?? 0;
        if (
          Math.abs(sourceBefore - body.data.expectedSourceQuantity) > epsilon ||
          Math.abs(destinationSectionBefore - body.data.expectedDestinationQuantity) > epsilon
        ) {
          throw new ApiError(409, "Stock changed while this transfer was open. Refresh the quantities and try again.");
        }
        if (body.data.quantity > sourceBefore + epsilon) {
          throw new ApiError(409, `Only ${sourceBefore} ${sourceProduct.unit} is available in ${sourceSection.name}.`);
        }

        const sourceTotalBefore = await stockTotal(tx, sourceProduct.id);
        const sameOutlet = body.data.destinationOutletId === req.storeroomId;
        const destinationTotalBefore =
          sourceProduct.id === destinationProduct.id
            ? sourceTotalBefore
            : await stockTotal(tx, destinationProduct.id);
        let remaining = body.data.quantity;
        for (const batch of sourceBatches) {
          if (remaining <= epsilon) break;
          const moved = Math.min(batch.quantity, remaining);
          await tx
            .update(stockBatchesTable)
            .set({ quantity: Math.max(0, batch.quantity - moved) })
            .where(eq(stockBatchesTable.id, batch.id));
          await tx.insert(stockBatchesTable).values({
            productId: destinationProduct.id,
            sectionId: destinationSection.id,
            quantity: moved,
            expiryDate: batch.expiryDate,
            createdBy: req.storeUser!.name,
          });
          remaining -= moved;
        }
        if (remaining > epsilon) {
          throw new ApiError(409, "The available stock changed. Refresh and try again.");
        }

        const [pending] = await tx
          .insert(stockTransfersTable)
          .values({
            reference: `pending-${body.data.clientKey}`,
            clientKey: body.data.clientKey,
            requestHash: hash,
            workspaceId: req.workspaceId!,
            sourceStoreroomId: req.storeroomId!,
            destinationStoreroomId: body.data.destinationOutletId,
            sourceProductId: sourceProduct.id,
            destinationProductId: destinationProduct.id,
            sourceSectionId: sourceSection.id,
            destinationSectionId: destinationSection.id,
            sourceOutletName: req.storeroom!.name,
            destinationOutletName: destinationAccess.outlet.name,
            sourceProductName: sourceProduct.name,
            destinationProductName: destinationProduct.name,
            sourceSectionName: sourceSection.name,
            destinationSectionName: destinationSection.name,
            unit: sourceProduct.unit,
            quantity: body.data.quantity,
            sourceBefore,
            sourceAfter: sourceBefore - body.data.quantity,
            destinationBefore: destinationSectionBefore,
            destinationAfter: destinationSectionBefore + body.data.quantity,
            sourceTotalBefore,
            sourceTotalAfter: sameOutlet
              ? sourceTotalBefore
              : sourceTotalBefore - body.data.quantity,
            destinationTotalBefore,
            destinationTotalAfter: sameOutlet
              ? destinationTotalBefore
              : destinationTotalBefore + body.data.quantity,
            note: body.data.note?.trim() ?? "",
            actor: req.storeUser!.name,
          })
          .returning({ id: stockTransfersTable.id });
        const reference = `TR-${String(pending.id).padStart(6, "0")}`;
        const [saved] = await tx
          .update(stockTransfersTable)
          .set({ reference })
          .where(eq(stockTransfersTable.id, pending.id))
          .returning();

        await tx.insert(stockMovementsTable).values([
          {
            productId: sourceProduct.id,
            type: "transfer_out",
            quantityDelta: -body.data.quantity,
            reason: `Transfer to ${destinationAccess.outlet.name} · ${destinationSection.name}`,
            actor: req.storeUser!.name,
            sectionId: sourceSection.id,
            sectionNameSnapshot: sourceSection.name,
            otherOutletName:
              body.data.destinationOutletId === req.storeroomId
                ? null
                : destinationAccess.outlet.name,
            transferReference: reference,
          },
          {
            productId: destinationProduct.id,
            type: "transfer_in",
            quantityDelta: body.data.quantity,
            reason: `Transfer from ${req.storeroom!.name} · ${sourceSection.name}`,
            actor: req.storeUser!.name,
            sectionId: destinationSection.id,
            sectionNameSnapshot: destinationSection.name,
            otherOutletName:
              body.data.destinationOutletId === req.storeroomId
                ? null
                : req.storeroom!.name,
            transferReference: reference,
          },
        ]);

        return saved;
      });
      res.status(201).json(CreateStockTransferResponse.parse(transfer));
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        const [previous] = await db
          .select()
          .from(stockTransfersTable)
          .where(eq(stockTransfersTable.clientKey, body.data.clientKey))
          .limit(1);
        if (previous && previous.requestHash === hash) {
          res.status(201).json(CreateStockTransferResponse.parse(previous));
          return;
        }
        res.status(409).json({ error: "A transfer with these details was already recorded." });
        return;
      }
      throw error;
    }
  },
);

export default router;
