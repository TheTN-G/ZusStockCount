import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  catalogueEventsTable,
  productCategoriesTable,
  productsTable,
  purchaseOrderEventsTable,
  purchaseOrderLinesTable,
  purchaseOrdersTable,
  stockBatchesTable,
  stockCountLinesTable,
  stockCountsTable,
  stockMovementsTable,
  stockSectionsTable,
  stockTransfersTable,
  deliveriesTable,
  securityEventsTable,
  passwordResetTokensTable,
  suppliersTable,
  storeUsersTable,
  storeroomMembershipsTable,
  storeroomsTable,
  workspacesTable,
} from "@workspace/db";
import { ObjectStorageService } from "../src/lib/objectStorage";
import { createApiRouter } from "../src/routes";
import type { StoreAuthResolver } from "../src/middlewares/storeUser";

const fixtureTag = `api-isolation-${crypto.randomUUID()}`;
const objectStorage = new ObjectStorageService();
const legacyOwnerId = `${fixtureTag}-legacy-owner`;
const legacyStaffId = `${fixtureTag}-legacy-staff`;
const secondOwnerId = `${fixtureTag}-new-owner`;
const secondStaffId = `${fixtureTag}-new-staff`;
const secondManagerInviteeId = `${fixtureTag}-manager-invitee`;
const secondOutletStaffId = `${fixtureTag}-sibling-outlet-staff`;

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl: string;
let secondaryApiProcess: ChildProcess | undefined;
let secondaryBaseUrl: string;
let fixtureStoreroomIds: number[] = [];
let fixtureWorkspaceIds: number[] = [];
let fixtureProductIds: number[] = [];
let fixtureTransferIds: number[] = [];
let fixtureOrderIds: number[] = [];
let fixtureCountIds: number[] = [];
let fixtureWorkbookObjectPaths: string[] = [];
let fixtureDeliveryIds: number[] = [];
let fixtureUserIds = [
  legacyOwnerId,
  legacyStaffId,
  secondOwnerId,
  secondStaffId,
  secondManagerInviteeId,
  secondOutletStaffId,
];

const resolveTestUser: StoreAuthResolver = (req) => {
  const userId = req.get("x-test-user-id") ?? null;
  return {
    userId,
    sessionClaims: userId
      ? {
          email: `${userId}@example.invalid`,
          name: userId,
        }
      : {},
  };
};

async function apiAt(
  apiBaseUrl: string,
  userId: string,
  path: string,
  options: {
    method?: string;
    storeroomId?: number;
    body?: unknown;
  } = {},
): Promise<{ response: Response; data: any }> {
  const headers: Record<string, string> = {
    "x-test-user-id": userId,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.storeroomId !== undefined) {
    headers["x-storeroom-id"] = String(options.storeroomId);
  }
  const response = await fetch(`${apiBaseUrl}/api${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let data: any = null;
  if (response.status !== 204) {
    const responseBody = await response.text();
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(
        `Expected JSON from ${options.method ?? "GET"} ${path}; received ${response.status} ` +
          `${response.headers.get("content-type")}: ${responseBody.slice(0, 400)}`,
      );
    }
  }
  return { response, data };
}

async function api(
  userId: string,
  path: string,
  options: {
    method?: string;
    storeroomId?: number;
    body?: unknown;
  } = {},
) {
  return apiAt(baseUrl, userId, path, options);
}

async function startSecondaryApiServer(): Promise<{
  child: ChildProcess;
  url: string;
}> {
  const workerPath = fileURLToPath(
    new URL("./po-issue-server.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [workerPath], {
    cwd: path.dirname(workerPath),
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for the second API server.")),
        15_000,
      );
      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onData = (chunk: Buffer | string) => {
        stdout += chunk.toString();
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const message = JSON.parse(line) as { event?: string; port?: number };
            if (message.event === "ready" && Number.isInteger(message.port)) {
              cleanup();
              resolve(message.port!);
              return;
            }
          } catch {
            // Ignore non-protocol output while waiting for the ready message.
          }
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Second API server exited before starting (code ${code}, signal ${signal}). ${stderr}`,
          ),
        );
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", onData);
      child.on("error", onError);
      child.on("exit", onExit);
    });
    return { child, url: `http://127.0.0.1:${port}` };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function stopApiServerProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

async function createProduct(userId: string, name: string, storeroomId?: number) {
  const categoryList = await api(userId, "/product-categories", { storeroomId });
  assert.equal(categoryList.response.status, 200, JSON.stringify(categoryList.data));
  assert.ok(
    categoryList.data.every((category: { isDefault: boolean }) => !category.isDefault),
    "preset product categories are not retained as defaults",
  );
  if (!categoryList.data.some((category: { key: string }) => category.key === "food")) {
    const category = await api(userId, "/product-categories", {
      method: "POST",
      storeroomId,
      body: { name: "Food" },
    });
    assert.equal(category.response.status, 201, JSON.stringify(category.data));
  }
  const { response, data } = await api(userId, "/products", {
    method: "POST",
    storeroomId,
    body: {
      name,
      category: "food",
      storage: "ambient",
      unit: "case",
      bundleSize: 1,
      minStock: 0,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.equal(data.trackExpiry, false);
  assert.equal(data.minDaysLeft, null);
  assert.equal(data.warnDays, 3);
  fixtureProductIds.push(data.id);
  return data;
}

async function createRoomData(userId: string, productId: number) {
  const adjustment = await api(userId, "/inventory/adjustments", {
    method: "POST",
    body: {
      productId,
      quantityDelta: 12,
      reason: "Isolation test opening stock",
    },
  });
  assert.equal(adjustment.response.status, 201, JSON.stringify(adjustment.data));

  const supplier = await api(userId, "/suppliers", {
    method: "POST",
    body: { name: `${fixtureTag}-order-supplier-${productId}` },
  });
  assert.equal(supplier.response.status, 201, JSON.stringify(supplier.data));
  const order = await api(userId, "/purchase-orders", {
    method: "POST",
    body: { supplierId: supplier.data.id, lines: [{ productId, quantity: 4 }] },
  });
  assert.equal(order.response.status, 201, JSON.stringify(order.data));
  fixtureOrderIds.push(order.data.id);

  const count = await api(userId, "/stock-counts", {
    method: "POST",
    body: { scope: "all" },
  });
  assert.equal(count.response.status, 201, JSON.stringify(count.data));
  fixtureCountIds.push(count.data.id);
  return { orderId: order.data.id, countId: count.data.id };
}

before(async () => {
  const preexistingRows = await Promise.all([
    db.select({ id: storeUsersTable.id }).from(storeUsersTable).limit(1),
    db.select({ id: workspacesTable.id }).from(workspacesTable).limit(1),
    db.select({ id: storeroomsTable.id }).from(storeroomsTable).limit(1),
    db
      .select({ id: storeroomMembershipsTable.id })
      .from(storeroomMembershipsTable)
      .limit(1),
    db.select({ id: productsTable.id }).from(productsTable).limit(1),
    db.select({ id: productCategoriesTable.id }).from(productCategoriesTable).limit(1),
    db.select({ id: stockBatchesTable.id }).from(stockBatchesTable).limit(1),
    db.select({ id: stockMovementsTable.id }).from(stockMovementsTable).limit(1),
    db.select({ id: stockSectionsTable.id }).from(stockSectionsTable).limit(1),
    db.select({ id: stockTransfersTable.id }).from(stockTransfersTable).limit(1),
    db.select({ id: purchaseOrdersTable.id }).from(purchaseOrdersTable).limit(1),
    db.select({ id: purchaseOrderEventsTable.id }).from(purchaseOrderEventsTable).limit(1),
    db.select({ id: stockCountsTable.id }).from(stockCountsTable).limit(1),
    db.select({ id: securityEventsTable.id }).from(securityEventsTable).limit(1),
    db.select({ id: catalogueEventsTable.id }).from(catalogueEventsTable).limit(1),
    db.select({ id: passwordResetTokensTable.id }).from(passwordResetTokensTable).limit(1),
  ]);
  assert.deepEqual(
    preexistingRows,
    [[], [], [], [], [], [], [], [], [], [], [], [], [], [], [], []],
    "The integration test database must be empty; use a dedicated database, not the app database.",
  );

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(resolveTestUser));
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const secondaryApi = await startSecondaryApiServer();
  secondaryApiProcess = secondaryApi.child;
  secondaryBaseUrl = secondaryApi.url;

  await db.insert(storeUsersTable).values([
    {
      id: legacyOwnerId,
      name: legacyOwnerId,
      email: `${legacyOwnerId}@example.invalid`,
      role: "admin",
    },
    {
      id: legacyStaffId,
      name: legacyStaffId,
      email: `${legacyStaffId}@example.invalid`,
      role: "staff",
    },
  ]);

  const [legacyProduct] = await db
    .insert(productsTable)
    .values({
      name: `${fixtureTag}-legacy-product`,
      category: "food",
      storage: "ambient",
      unit: "case",
      storeroomId: null,
    })
    .returning();
  fixtureProductIds.push(legacyProduct.id);

  await db.insert(stockBatchesTable).values({
    productId: legacyProduct.id,
    quantity: 7,
    createdBy: "legacy import",
  });
  await db.insert(stockMovementsTable).values({
    productId: legacyProduct.id,
    type: "adjustment",
    quantityDelta: 7,
    reason: "Legacy opening stock",
    actor: "legacy import",
  });

  const [legacyOrder] = await db
    .insert(purchaseOrdersTable)
    .values({ storeroomId: null, requestedBy: "legacy import" })
    .returning();
  fixtureOrderIds.push(legacyOrder.id);

  const [legacyCount] = await db
    .insert(stockCountsTable)
    .values({
      storeroomId: null,
      scope: "all",
      createdBy: "legacy import",
    })
    .returning();
  fixtureCountIds.push(legacyCount.id);
  await db.insert(stockCountLinesTable).values({
    countId: legacyCount.id,
    productId: legacyProduct.id,
    productName: legacyProduct.name,
    expectedQuantity: 7,
    unit: "case",
  });
});

after(async () => {
  if (secondaryApiProcess) {
    secondaryApiProcess.kill("SIGTERM");
    await once(secondaryApiProcess, "exit");
  }
  if (server) {
    server.close();
    await once(server, "close");
  }
  for (const objectPath of fixtureWorkbookObjectPaths) {
    try {
      await objectStorage.deleteObject(objectPath);
    } catch (error) {
      console.error(`Could not clean up test workbook ${objectPath}:`, error);
    }
  }
  if (fixtureCountIds.length) {
    await db
      .delete(stockCountLinesTable)
      .where(inArray(stockCountLinesTable.countId, fixtureCountIds));
  }
  if (fixtureTransferIds.length) {
    await db
      .delete(stockTransfersTable)
      .where(inArray(stockTransfersTable.id, fixtureTransferIds));
  }
  if (fixtureDeliveryIds.length) {
    await db
      .delete(deliveriesTable)
      .where(inArray(deliveriesTable.id, fixtureDeliveryIds));
  }
  if (fixtureOrderIds.length) {
    await db
      .delete(purchaseOrderLinesTable)
      .where(inArray(purchaseOrderLinesTable.orderId, fixtureOrderIds));
  }
  const outletProducts = fixtureStoreroomIds.length
    ? await db
        .select({ id: productsTable.id })
        .from(productsTable)
        .where(inArray(productsTable.storeroomId, fixtureStoreroomIds))
    : [];
  const cleanupProductIds = [
    ...new Set([
      ...fixtureProductIds,
      ...outletProducts.map(({ id }) => id),
    ]),
  ];
  if (cleanupProductIds.length) {
    await db
      .delete(stockBatchesTable)
      .where(inArray(stockBatchesTable.productId, cleanupProductIds));
    await db
      .delete(stockMovementsTable)
      .where(inArray(stockMovementsTable.productId, cleanupProductIds));
  }
  if (fixtureCountIds.length) {
    await db.delete(stockCountsTable).where(inArray(stockCountsTable.id, fixtureCountIds));
  }
  if (fixtureOrderIds.length) {
    await db
      .delete(purchaseOrdersTable)
      .where(inArray(purchaseOrdersTable.id, fixtureOrderIds));
  }
  if (cleanupProductIds.length) {
    await db
      .delete(productsTable)
      .where(inArray(productsTable.id, cleanupProductIds));
  }
  if (fixtureStoreroomIds.length) {
    await db
      .delete(passwordResetTokensTable)
      .where(inArray(passwordResetTokensTable.storeroomId, fixtureStoreroomIds));
    await db
      .delete(securityEventsTable)
      .where(inArray(securityEventsTable.storeroomId, fixtureStoreroomIds));
  }
  if (fixtureStoreroomIds.length) {
    await db
      .delete(storeroomsTable)
      .where(inArray(storeroomsTable.id, fixtureStoreroomIds));
  }
  if (fixtureWorkspaceIds.length) {
    await db
      .delete(workspacesTable)
      .where(inArray(workspacesTable.id, fixtureWorkspaceIds));
  }
  if (fixtureUserIds.length) {
    await db
      .delete(storeroomMembershipsTable)
      .where(inArray(storeroomMembershipsTable.userId, fixtureUserIds));
    await db
      .delete(storeUsersTable)
      .where(inArray(storeUsersTable.id, fixtureUserIds));
  }
  await pool.end();
});

test("legacy backfill, new-owner setup, and API data remain isolated by storeroom", async () => {
  const invalidPublicReset = await fetch(
    `${baseUrl}/api/users/password-reset/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "invalid", password: "not-a-real-password" }),
    },
  );
  assert.equal(invalidPublicReset.status, 400);

  const [migrated, newOwner] = await Promise.all([
    api(legacyOwnerId, "/me"),
    api(secondOwnerId, "/me"),
  ]);
  assert.equal(migrated.response.status, 200, JSON.stringify(migrated.data));
  const legacyRoomId = migrated.data.activeStoreroomId as number;
  fixtureStoreroomIds.push(legacyRoomId);
  assert.equal(migrated.data.role, "owner");
  assert.equal(migrated.data.storeName, "Main Outlet");
  assert.equal(migrated.data.workspace.isOwner, true);
  assert.equal(migrated.data.outlets.length, 1);
  fixtureWorkspaceIds.push(migrated.data.workspace.id);
  assert.equal(newOwner.response.status, 200, JSON.stringify(newOwner.data));
  const secondRoomId = newOwner.data.activeOutletId as number;
  fixtureStoreroomIds.push(secondRoomId);
  fixtureWorkspaceIds.push(newOwner.data.workspace.id);
  assert.notEqual(secondRoomId, legacyRoomId);
  assert.equal(newOwner.data.role, "owner");
  assert.equal(newOwner.data.storeName, "Main Outlet");
  assert.equal(newOwner.data.workspace.setupComplete, false);
  assert.notEqual(newOwner.data.workspace.id, migrated.data.workspace.id);
  assert.deepEqual(
    newOwner.data.outlets.map(({ id, name }: { id: number; name: string }) => [
      id,
      name,
    ]),
    [[secondRoomId, "Main Outlet"]],
  );
  assert.equal(newOwner.data.workspace.isOwner, true);

  const [backfilledProduct] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, fixtureProductIds[0]!));
  const [backfilledOrder] = await db
    .select()
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, fixtureOrderIds[0]!));
  const [backfilledCount] = await db
    .select()
    .from(stockCountsTable)
    .where(eq(stockCountsTable.id, fixtureCountIds[0]!));
  assert.equal(backfilledProduct?.storeroomId, legacyRoomId);
  assert.equal(backfilledOrder?.storeroomId, legacyRoomId);
  assert.equal(backfilledCount?.storeroomId, legacyRoomId);

  const memberships = await db
    .select({
      userId: storeroomMembershipsTable.userId,
      role: storeroomMembershipsTable.role,
    })
    .from(storeroomMembershipsTable)
    .where(eq(storeroomMembershipsTable.storeroomId, legacyRoomId));
  assert.deepEqual(
    memberships.map(({ userId, role }) => [userId, role]).sort(),
    [
      [legacyOwnerId, "owner"],
      [legacyStaffId, "staff"],
    ].sort(),
  );

  const allInitialMemberships = await db
    .select({
      storeroomId: storeroomMembershipsTable.storeroomId,
      userId: storeroomMembershipsTable.userId,
      role: storeroomMembershipsTable.role,
    })
    .from(storeroomMembershipsTable)
    .where(
      inArray(storeroomMembershipsTable.userId, [
        legacyOwnerId,
        legacyStaffId,
        secondOwnerId,
      ]),
    );
  assert.deepEqual(
    allInitialMemberships
      .map(({ storeroomId, userId, role }) => [storeroomId, userId, role])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [
      [legacyRoomId, legacyOwnerId, "owner"],
      [legacyRoomId, legacyStaffId, "staff"],
      [secondRoomId, secondOwnerId, "owner"],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  );
  assert.ok(
    [legacyOwnerId, legacyStaffId, secondOwnerId].every(
      (userId) =>
        allInitialMemberships.filter((membership) => membership.userId === userId)
          .length === 1,
    ),
  );
  const initialRoomCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storeroomsTable);
  assert.equal(initialRoomCount[0]?.count, 2);
  const [unclaimedProduct] = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.storeroomId, secondRoomId));
  assert.equal(unclaimedProduct, undefined);

  const [repeatedMigrationCheck, repeatedNewOwnerCheck] = await Promise.all([
    api(legacyOwnerId, "/me"),
    api(secondOwnerId, "/me"),
  ]);
  assert.equal(repeatedMigrationCheck.response.status, 200);
  assert.equal(repeatedNewOwnerCheck.response.status, 200);
  assert.equal(repeatedMigrationCheck.data.activeStoreroomId, legacyRoomId);
  assert.equal(repeatedNewOwnerCheck.data.activeStoreroomId, secondRoomId);
  const [retriedProduct] = await db
    .select({ storeroomId: productsTable.storeroomId })
    .from(productsTable)
    .where(eq(productsTable.id, fixtureProductIds[0]!));
  const [retriedOrder] = await db
    .select({ storeroomId: purchaseOrdersTable.storeroomId })
    .from(purchaseOrdersTable)
    .where(eq(purchaseOrdersTable.id, fixtureOrderIds[0]!));
  const [retriedCount] = await db
    .select({ storeroomId: stockCountsTable.storeroomId })
    .from(stockCountsTable)
    .where(eq(stockCountsTable.id, fixtureCountIds[0]!));
  assert.equal(retriedProduct?.storeroomId, legacyRoomId);
  assert.equal(retriedOrder?.storeroomId, legacyRoomId);
  assert.equal(retriedCount?.storeroomId, legacyRoomId);
  const retriedMemberships = await db
    .select({
      storeroomId: storeroomMembershipsTable.storeroomId,
      userId: storeroomMembershipsTable.userId,
    })
    .from(storeroomMembershipsTable)
    .where(
      inArray(storeroomMembershipsTable.userId, [
        legacyOwnerId,
        legacyStaffId,
        secondOwnerId,
      ]),
    );
  assert.equal(retriedMemberships.length, 3);
  assert.deepEqual(
    retriedMemberships
      .map(({ storeroomId, userId }) => [storeroomId, userId])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    [
      [legacyRoomId, legacyOwnerId],
      [legacyRoomId, legacyStaffId],
      [secondRoomId, secondOwnerId],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  );
  const roomCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(storeroomsTable);
  assert.equal(roomCount[0]?.count, 2, "Concurrent retries must not create another room.");

  const secondOutlet = await api(secondOwnerId, "/outlets", {
    method: "POST",
    body: { name: "Airport Outlet" },
  });
  assert.equal(secondOutlet.response.status, 201, JSON.stringify(secondOutlet.data));
  const secondOutletId = secondOutlet.data.id as number;
  fixtureStoreroomIds.push(secondOutletId);
  const defaultOutletUser = await api(secondOwnerId, "/me");
  assert.equal(defaultOutletUser.response.status, 200);
  assert.equal(defaultOutletUser.data.activeOutletId, secondRoomId);
  assert.deepEqual(
    defaultOutletUser.data.outlets.map(
      ({ id, name }: { id: number; name: string }) => [id, name],
    ),
    [
      [secondRoomId, "Main Outlet"],
      [secondOutletId, "Airport Outlet"],
    ],
  );
  const secondOutletUser = await api(secondOwnerId, "/me", {
    storeroomId: secondOutletId,
  });
  assert.equal(secondOutletUser.response.status, 200);
  assert.equal(secondOutletUser.data.workspace.id, newOwner.data.workspace.id);
  assert.equal(secondOutletUser.data.activeOutletId, secondOutletId);
  assert.deepEqual(
    secondOutletUser.data.outlets.map(
      ({ id, name }: { id: number; name: string }) => [id, name],
    ),
    [
      [secondRoomId, "Main Outlet"],
      [secondOutletId, "Airport Outlet"],
    ],
  );
  const renamedSiblingOutlet = await api(
    secondOwnerId,
    `/outlets/${secondOutletId}/name`,
    { method: "PATCH", body: { name: "  Airport Annex  " } },
  );
  assert.equal(
    renamedSiblingOutlet.response.status,
    200,
    JSON.stringify(renamedSiblingOutlet.data),
  );
  assert.equal(renamedSiblingOutlet.data.name, "Airport Annex");
  const profileAfterOutletRename = await api(secondOwnerId, "/me");
  assert.deepEqual(
    profileAfterOutletRename.data.outlets.map(
      ({ id, name }: { id: number; name: string }) => [id, name],
    ),
    [
      [secondRoomId, "Main Outlet"],
      [secondOutletId, "Airport Annex"],
    ],
  );
  const blankOutletRename = await api(
    secondOwnerId,
    `/outlets/${secondOutletId}/name`,
    { method: "PATCH", body: { name: "   " } },
  );
  assert.equal(blankOutletRename.response.status, 400);
  const persistedOutletName = await db
    .select({ name: storeroomsTable.name })
    .from(storeroomsTable)
    .where(eq(storeroomsTable.id, secondOutletId));
  assert.equal(persistedOutletName[0]?.name, "Airport Annex");
  const outletDetails = await api(secondOwnerId, `/outlets/${secondOutletId}`, {
    method: "PATCH",
    body: {
      contactEmail: "airport@example.invalid",
      contactPhone: "+60 3 5555 0101",
      businessAddress: "10 Airport Road, Sepang",
    },
  });
  assert.equal(outletDetails.response.status, 200, JSON.stringify(outletDetails.data));
  assert.equal(outletDetails.data.contactEmail, "airport@example.invalid");
  assert.equal(outletDetails.data.businessAddress, "10 Airport Road, Sepang");
  const outletProfile = await api(secondOwnerId, "/me");
  const mainOutletProfile = outletProfile.data.outlets.find(
    ({ id }: { id: number }) => id === secondRoomId,
  );
  const secondOutletProfile = outletProfile.data.outlets.find(
    ({ id }: { id: number }) => id === secondOutletId,
  );
  assert.equal(mainOutletProfile?.contactEmail, null);
  assert.equal(mainOutletProfile?.businessAddress, null);
  assert.equal(secondOutletProfile?.contactEmail, "airport@example.invalid");
  assert.equal(secondOutletProfile?.contactPhone, "+60 3 5555 0101");
  assert.equal(secondOutletProfile?.businessAddress, "10 Airport Road, Sepang");
  const crossWorkspaceOutletUpdate = await api(
    legacyOwnerId,
    `/outlets/${secondOutletId}`,
    {
      method: "PATCH",
      body: {
        contactEmail: "wrong-workspace@example.invalid",
        contactPhone: null,
        businessAddress: null,
      },
    },
  );
  assert.equal(crossWorkspaceOutletUpdate.response.status, 404);
  const outletProduct = await createProduct(
    secondOwnerId,
    `${fixtureTag}-second-outlet-product`,
    secondOutletId,
  );
  const mainOutletProduct = await createProduct(
    secondOwnerId,
    `${fixtureTag}-main-outlet-product`,
    secondRoomId,
  );
  const mainOutletDetails = await api(secondOwnerId, `/outlets/${secondRoomId}`, {
    method: "PATCH",
    body: {
      contactEmail: "main@example.invalid",
      contactPhone: "+60 3 5555 0100",
      businessAddress: "1 Main Street, Kuala Lumpur",
    },
  });
  assert.equal(mainOutletDetails.response.status, 200, JSON.stringify(mainOutletDetails.data));
  const mainOutletOrder = await api(secondOwnerId, "/purchase-orders", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { lines: [{ productId: mainOutletProduct.id, quantity: 2 }] },
  });
  assert.equal(mainOutletOrder.response.status, 201, JSON.stringify(mainOutletOrder.data));
  fixtureOrderIds.push(mainOutletOrder.data.id);
  assert.deepEqual(mainOutletOrder.data.outlet, {
    id: secondRoomId,
    name: "Main Outlet",
    contactEmail: "main@example.invalid",
    contactPhone: "+60 3 5555 0100",
    businessAddress: "1 Main Street, Kuala Lumpur",
  });
  const secondOutletOrder = await api(secondOwnerId, "/purchase-orders", {
    method: "POST",
    storeroomId: secondOutletId,
    body: { lines: [{ productId: outletProduct.id, quantity: 2 }] },
  });
  assert.equal(secondOutletOrder.response.status, 201, JSON.stringify(secondOutletOrder.data));
  fixtureOrderIds.push(secondOutletOrder.data.id);
  assert.deepEqual(secondOutletOrder.data.outlet, {
    id: secondOutletId,
    name: "Airport Annex",
    contactEmail: "airport@example.invalid",
    contactPhone: "+60 3 5555 0101",
    businessAddress: "10 Airport Road, Sepang",
  });

  const mainSupplier = await api(secondOwnerId, "/suppliers", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { name: `${fixtureTag}-main-supplier` },
  });
  assert.equal(mainSupplier.response.status, 201, JSON.stringify(mainSupplier.data));
  const outletSupplier = await api(secondOwnerId, "/suppliers", {
    method: "POST",
    storeroomId: secondOutletId,
    body: { name: `${fixtureTag}-outlet-supplier` },
  });
  assert.equal(outletSupplier.response.status, 201, JSON.stringify(outletSupplier.data));
  const catalogueHistorySupplier = await api(secondOwnerId, "/suppliers", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { name: `${fixtureTag}-catalogue-history-supplier` },
  });
  assert.equal(
    catalogueHistorySupplier.response.status,
    201,
    JSON.stringify(catalogueHistorySupplier.data),
  );
  const catalogueSupplierUpdate = await api(
    secondOwnerId,
    `/suppliers/${catalogueHistorySupplier.data.id}`,
    {
      method: "PATCH",
      storeroomId: secondRoomId,
      body: { contactName: "Catalogue history contact" },
    },
  );
  assert.equal(catalogueSupplierUpdate.response.status, 200);
  const catalogueSupplierArchive = await api(
    secondOwnerId,
    `/suppliers/${catalogueHistorySupplier.data.id}`,
    {
      method: "PATCH",
      storeroomId: secondRoomId,
      body: { active: false },
    },
  );
  assert.equal(catalogueSupplierArchive.response.status, 200);
  const catalogueSupplierActivity = await api(
    secondOwnerId,
    "/activity",
    { storeroomId: secondRoomId },
  );
  const supplierEvents = catalogueSupplierActivity.data.filter(
    (entry: any) => entry.group === "catalogue" && entry.target === catalogueHistorySupplier.data.name,
  );
  assert.deepEqual(
    supplierEvents.map((entry: any) => entry.action).sort(),
    ["Supplier added", "Supplier archived", "Supplier updated"].sort(),
  );
  const supplierUpdateEvent = supplierEvents.find(
    (entry: any) => entry.action === "Supplier updated",
  );
  assert.equal(supplierUpdateEvent.actor, secondOwnerId);
  assert.ok(Number.isFinite(Date.parse(supplierUpdateEvent.at)));
  assert.match(supplierUpdateEvent.detail, /Changed fields: Contact name/);
  assert.ok(
    !supplierUpdateEvent.detail.includes("Catalogue history contact"),
    "Supplier contact values should not be exposed in Activity details.",
  );
  const siblingSupplierActivity = await api(
    secondOwnerId,
    "/activity",
    { storeroomId: secondOutletId },
  );
  assert.ok(
    !siblingSupplierActivity.data.some(
      (entry: any) => entry.target === catalogueHistorySupplier.data.name,
    ),
    "Supplier catalogue history must not leak into another outlet's Activity.",
  );

  const createdAccountName = `${fixtureTag} account`;
  const createdAccount = await api(secondOwnerId, "/users/accounts", {
    method: "POST",
    storeroomId: secondRoomId,
    body: {
      name: createdAccountName,
      username: `task107-${crypto.randomUUID().slice(0, 8)}`,
      role: "staff",
      temporaryPassword: "temporary-password-107",
    },
  });
  assert.equal(createdAccount.response.status, 201, JSON.stringify(createdAccount.data));
  fixtureUserIds.push(createdAccount.data.id);
  const createdAccountEvents = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  const createdAccountEvent = createdAccountEvents.data.find(
    ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
      eventType === "teammate_created" && targetUserId === createdAccount.data.id,
  );
  assert.ok(createdAccountEvent, JSON.stringify(createdAccountEvents.data));
  assert.equal(createdAccountEvent.actorUserId, secondOwnerId);
  assert.equal(createdAccountEvent.actorName, secondOwnerId);
  assert.equal(createdAccountEvent.targetUserId, createdAccount.data.id);
  assert.equal(createdAccountEvent.targetName, createdAccountName);
  assert.equal(createdAccountEvent.storeroomId, secondRoomId);
  assert.ok(Number.isFinite(Date.parse(createdAccountEvent.createdAt)));

  const createdAccountActivity = await api(
    secondOwnerId,
    "/activity",
    { storeroomId: secondRoomId },
  );
  const createdAccountActivityEvent = createdAccountActivity.data.find(
    (entry: any) =>
      entry.group === "team" &&
      entry.action === "Teammate created" &&
      entry.target === createdAccountName,
  );
  assert.ok(createdAccountActivityEvent);
  assert.equal(createdAccountActivityEvent.actor, secondOwnerId);
  assert.match(createdAccountActivityEvent.detail, /Role: staff/);
  assert.ok(Number.isFinite(Date.parse(createdAccountActivityEvent.at)));

  const createdAccountStaffActivity = await api(
    createdAccount.data.id,
    "/activity",
    { storeroomId: secondRoomId },
  );
  assert.equal(createdAccountStaffActivity.response.status, 200);
  assert.ok(
    !createdAccountStaffActivity.data.some(
      (entry: any) => entry.group === "team" && entry.target === createdAccountName,
    ),
    "Staff must not see security history in Activity.",
  );
  const createdAccountStaffSecurityEvents = await api(
    createdAccount.data.id,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  assert.equal(createdAccountStaffSecurityEvents.response.status, 403);

  const createdAccountSiblingActivity = await api(
    secondOwnerId,
    "/activity",
    { storeroomId: secondOutletId },
  );
  assert.ok(
    !createdAccountSiblingActivity.data.some(
      (entry: any) => entry.group === "team" && entry.target === createdAccountName,
    ),
    "Teammate security history must not appear in a sibling outlet's Activity.",
  );

  const currentMonthParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(new Date());
  const currentMonthYear = currentMonthParts.find((part) => part.type === "year")?.value;
  const currentMonth = currentMonthParts.find((part) => part.type === "month")?.value;
  assert.ok(currentMonthYear && currentMonth);
  const currentPrefix = `PO-${currentMonthYear}${currentMonth}`;
  const previousMonthDate = new Date(
    Date.UTC(2000 + Number(currentMonthYear), Number(currentMonth) - 2, 1),
  );
  const previousMonthParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(previousMonthDate);
  const previousMonthYear = previousMonthParts.find((part) => part.type === "year")?.value;
  const previousMonth = previousMonthParts.find((part) => part.type === "month")?.value;
  assert.ok(previousMonthYear && previousMonth);
  const [previousMonthOrder] = await db
    .insert(purchaseOrdersTable)
    .values({
      storeroomId: secondRoomId,
      status: "issued",
      requestedBy: secondOwnerId,
      orderNumber: `PO-${previousMonthYear}${previousMonth}999`,
      issuedAt: previousMonthDate,
    })
    .returning({ id: purchaseOrdersTable.id });
  fixtureOrderIds.push(previousMonthOrder.id);

  const createIssueDrafts = async (
    storeroomId: number,
    supplierId: number,
    productId: number,
    count: number,
  ) => {
    const drafts = await Promise.all(
      Array.from({ length: count }, () =>
        api(secondOwnerId, "/purchase-orders", {
          method: "POST",
          storeroomId,
          body: { supplierId, lines: [{ productId, quantity: 1 }] },
        }),
      ),
    );
    for (const draft of drafts) {
      assert.equal(draft.response.status, 201, JSON.stringify(draft.data));
      fixtureOrderIds.push(draft.data.id);
    }
    return drafts.map(({ data }) => data.id as number);
  };
  const [mainDraftIds, outletDraftIds] = await Promise.all([
    createIssueDrafts(secondRoomId, mainSupplier.data.id, mainOutletProduct.id, 6),
    createIssueDrafts(secondOutletId, outletSupplier.data.id, outletProduct.id, 2),
  ]);
  const approveRequests = async (storeroomId: number, orderIds: number[]) =>
    Promise.all(
      orderIds.map((orderId) =>
        api(secondOwnerId, `/purchase-orders/${orderId}/decision`, {
          method: "POST",
          storeroomId,
          body: { decision: "approved" },
        }),
      ),
    );
  const [localMainOrders, remoteMainOrders, issuedOutletOrders] = await Promise.all([
    approveRequests(secondRoomId, mainDraftIds.slice(0, 3)),
    Promise.all(
      mainDraftIds.slice(3).map((orderId) =>
        apiAt(
          secondaryBaseUrl,
          secondOwnerId,
          `/purchase-orders/${orderId}/decision`,
          { method: "POST", storeroomId: secondRoomId, body: { decision: "approved" } },
        ),
      ),
    ),
    approveRequests(secondOutletId, outletDraftIds),
  ]);
  const issuedMainOrders = [...localMainOrders, ...remoteMainOrders];
  for (const issued of [...issuedMainOrders, ...issuedOutletOrders]) {
    assert.equal(issued.response.status, 200, JSON.stringify(issued.data));
    assert.equal(issued.data.status, "approved");
    assert.ok(issued.data.orderNumber, "An approved purchase order must have a number.");
  }
  const mainSequence = issuedMainOrders
    .map(({ data }) => data.orderNumber as string)
    .sort();
  const outletSequence = issuedOutletOrders
    .map(({ data }) => data.orderNumber as string)
    .sort();
  assert.deepEqual(
    mainSequence,
    [1, 2, 3, 4, 5, 6].map((sequence) => `${currentPrefix}${String(sequence).padStart(3, "0")}`),
    "Concurrent approvals across two API processes must have unique sequential numbers.",
  );
  assert.deepEqual(
    outletSequence,
    [1, 2].map((sequence) => `${currentPrefix}${String(sequence).padStart(3, "0")}`),
    "Each outlet must maintain its own monthly PO number sequence.",
  );
  const persistedMainOrders = await db
    .select({
      id: purchaseOrdersTable.id,
      status: purchaseOrdersTable.status,
      orderNumber: purchaseOrdersTable.orderNumber,
    })
    .from(purchaseOrdersTable)
    .where(inArray(purchaseOrdersTable.id, mainDraftIds));
  assert.equal(persistedMainOrders.length, mainDraftIds.length);
  assert.ok(
    persistedMainOrders.every(
      ({ status, orderNumber }) => status === "approved" && orderNumber !== null,
    ),
    "Every approved order must persist its allocated PO number.",
  );
  assert.equal(
    new Set(persistedMainOrders.map(({ orderNumber }) => orderNumber)).size,
    persistedMainOrders.length,
    "Persisted PO numbers must remain distinct across API processes.",
  );

  const restartDraft = await api(secondOwnerId, "/purchase-orders", {
    method: "POST",
    storeroomId: secondRoomId,
    body: {
      supplierId: mainSupplier.data.id,
      lines: [{ productId: mainOutletProduct.id, quantity: 1 }],
    },
  });
  assert.equal(restartDraft.response.status, 201, JSON.stringify(restartDraft.data));
  fixtureOrderIds.push(restartDraft.data.id);

  await stopApiServerProcess(secondaryApiProcess!);
  secondaryApiProcess = undefined;
  const restartedApi = await startSecondaryApiServer();
  secondaryApiProcess = restartedApi.child;
  secondaryBaseUrl = restartedApi.url;

  const approvedAfterRestart = await apiAt(
    secondaryBaseUrl,
    secondOwnerId,
    `/purchase-orders/${restartDraft.data.id}/decision`,
    { method: "POST", storeroomId: secondRoomId, body: { decision: "approved" } },
  );
  assert.equal(approvedAfterRestart.response.status, 200, JSON.stringify(approvedAfterRestart.data));
  assert.equal(
    approvedAfterRestart.data.orderNumber,
    `${currentPrefix}007`,
    "A fresh API process must continue the outlet's monthly PO sequence from the database.",
  );
  assert.notEqual(
    approvedAfterRestart.data.orderNumber,
    issuedMainOrders[0]!.data.orderNumber,
    "Orders issued before and after an API restart must retain distinct monthly numbers.",
  );
  const persistedRestartOrders = await db
    .select({
      id: purchaseOrdersTable.id,
      orderNumber: purchaseOrdersTable.orderNumber,
    })
    .from(purchaseOrdersTable)
    .where(inArray(purchaseOrdersTable.id, [mainDraftIds[0]!, restartDraft.data.id]));
  assert.equal(persistedRestartOrders.length, 2);
  assert.equal(
    new Set(persistedRestartOrders.map(({ orderNumber }) => orderNumber)).size,
    2,
    "The pre-restart and post-restart PO numbers must both remain distinct in the database.",
  );

  const updatedSecondOutletDetails = await api(
    secondOwnerId,
    `/outlets/${secondOutletId}`,
    {
      method: "PATCH",
      body: {
        contactEmail: "new-airport@example.invalid",
        contactPhone: "+60 3 5555 0102",
        businessAddress: "20 Airport Road, Sepang",
      },
    },
  );
  assert.equal(updatedSecondOutletDetails.response.status, 200);
  const mainOutletOrders = await api(secondOwnerId, "/purchase-orders", {
    storeroomId: secondRoomId,
  });
  const airportOutletOrders = await api(secondOwnerId, "/purchase-orders", {
    storeroomId: secondOutletId,
  });
  assert.deepEqual(
    mainOutletOrders.data.find(({ id }: { id: number }) => id === mainOutletOrder.data.id)
      ?.outlet,
    mainOutletOrder.data.outlet,
  );
  assert.deepEqual(
    airportOutletOrders.data.find(({ id }: { id: number }) => id === secondOutletOrder.data.id)
      ?.outlet,
    {
      id: secondOutletId,
      name: "Airport Annex",
      contactEmail: "new-airport@example.invalid",
      contactPhone: "+60 3 5555 0102",
      businessAddress: "20 Airport Road, Sepang",
    },
  );
  const mainOutletProducts = await api(secondOwnerId, "/products", {
    storeroomId: secondRoomId,
  });
  const secondOutletProducts = await api(secondOwnerId, "/products", {
    storeroomId: secondOutletId,
  });
  assert.ok(!mainOutletProducts.data.some(({ id }: { id: number }) => id === outletProduct.id));
  assert.ok(secondOutletProducts.data.some(({ id }: { id: number }) => id === outletProduct.id));
  const renamedWorkspace = await api(secondOwnerId, "/workspaces/me", {
    method: "PATCH",
    body: {
      name: `${fixtureTag} Business`,
      contactEmail: "workspace@example.invalid",
      contactPhone: "+60 3 5555 0202",
      businessAddress: "Workspace office",
    },
  });
  assert.equal(renamedWorkspace.response.status, 200, JSON.stringify(renamedWorkspace.data));
  assert.equal(renamedWorkspace.data.name, `${fixtureTag} Business`);
  const separatedProfiles = await api(secondOwnerId, "/me");
  assert.equal(separatedProfiles.data.workspace.contactEmail, "workspace@example.invalid");
  assert.equal(separatedProfiles.data.workspace.contactPhone, "+60 3 5555 0202");
  assert.equal(separatedProfiles.data.workspace.businessAddress, "Workspace office");
  assert.equal(
    separatedProfiles.data.outlets.find(({ id }: { id: number }) => id === secondOutletId)
      ?.contactEmail,
    "new-airport@example.invalid",
  );
  const unauthorizedOutlet = await api(legacyStaffId, "/outlets", {
    method: "POST",
    body: { name: "Unauthorized Outlet" },
  });
  assert.equal(unauthorizedOutlet.response.status, 403);

  await db.insert(storeUsersTable).values([
    {
      id: secondStaffId,
      name: secondStaffId,
      email: `${secondStaffId}@example.invalid`,
      role: "staff",
    },
    {
      id: secondManagerInviteeId,
      name: secondManagerInviteeId,
      email: `${secondManagerInviteeId}@example.invalid`,
      role: "staff",
    },
    {
      id: secondOutletStaffId,
      name: secondOutletStaffId,
      email: `${secondOutletStaffId}@example.invalid`,
      role: "staff",
    },
  ]);
  const addedStaff = await api(secondOwnerId, "/users", {
    method: "POST",
    body: { email: `${secondStaffId}@example.invalid`, role: "staff" },
  });
  assert.equal(addedStaff.response.status, 201, JSON.stringify(addedStaff.data));
  const addedStaffSecurityEvents = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  assert.ok(
    addedStaffSecurityEvents.data.some(
      ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
        eventType === "teammate_added" && targetUserId === secondStaffId,
    ),
    JSON.stringify(addedStaffSecurityEvents.data),
  );
  const addedSiblingOutletStaff = await api(secondOwnerId, "/users", {
    method: "POST",
    storeroomId: secondOutletId,
    body: {
      email: `${secondOutletStaffId}@example.invalid`,
      role: "staff",
      access: {
        dashboard: "view",
        receiving: "view",
        deliveryRecords: "view",
        products: "view",
        suppliers: "view",
        stockTransfers: "view",
        purchaseOrders: "view",
        approvals: "view",
        activity: "view",
        stockCount: "view",
      },
    },
  });
  assert.equal(
    addedSiblingOutletStaff.response.status,
    201,
    JSON.stringify(addedSiblingOutletStaff.data),
  );
  const staffCannotCompleteWorkspaceSetup = await api(
    secondStaffId,
    "/workspaces/me/setup",
    {
      method: "PATCH",
      body: {
        name: `${fixtureTag} Unauthorized Workspace`,
        contactEmail: null,
        contactPhone: null,
        businessAddress: null,
        firstOutletName: "Unauthorized Outlet Name",
      },
    },
  );
  assert.equal(staffCannotCompleteWorkspaceSetup.response.status, 403);
  const [workspaceBeforeSetup] = await db
    .select({
      name: workspacesTable.name,
      setupComplete: workspacesTable.setupComplete,
    })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, newOwner.data.workspace.id));
  assert.deepEqual(workspaceBeforeSetup, {
    name: `${fixtureTag} Business`,
    setupComplete: false,
  });
  const [firstOutletBeforeSetup] = await db
    .select({ name: storeroomsTable.name })
    .from(storeroomsTable)
    .where(eq(storeroomsTable.id, secondRoomId));
  assert.equal(firstOutletBeforeSetup?.name, "Main Outlet");

  const workspaceProfileBeforeInvalidSetup = await db
    .select({
      name: workspacesTable.name,
      contactEmail: workspacesTable.contactEmail,
      contactPhone: workspacesTable.contactPhone,
      businessAddress: workspacesTable.businessAddress,
      setupComplete: workspacesTable.setupComplete,
    })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, newOwner.data.workspace.id));
  const invalidRegistrationAttempts: Array<{
    description: string;
    field: string;
    overrides: Record<string, string>;
  }> = [
    { description: "empty workspace name", field: "name", overrides: { name: "" } },
    { description: "blank workspace name", field: "name", overrides: { name: "   " } },
    { description: "oversized workspace name", field: "name", overrides: { name: "W".repeat(81) } },
    { description: "empty first outlet name", field: "firstOutletName", overrides: { firstOutletName: "" } },
    {
      description: "oversized first outlet name",
      field: "firstOutletName",
      overrides: { firstOutletName: "O".repeat(81) },
    },
    { description: "empty contact email", field: "contactEmail", overrides: { contactEmail: "" } },
    {
      description: "invalid contact email",
      field: "contactEmail",
      overrides: { contactEmail: "not-an-email" },
    },
    {
      description: "oversized contact email",
      field: "contactEmail",
      overrides: { contactEmail: `${"a".repeat(306)}@example.invalid` },
    },
    {
      description: "oversized contact phone",
      field: "contactPhone",
      overrides: { contactPhone: "1".repeat(41) },
    },
    {
      description: "oversized business address",
      field: "businessAddress",
      overrides: { businessAddress: "A".repeat(501) },
    },
  ];
  for (const { description, field, overrides } of invalidRegistrationAttempts) {
    const rejectedRegistration = await api(secondOwnerId, "/workspaces/me/setup", {
      method: "PATCH",
      body: {
        name: `${fixtureTag} Rejected Registration`,
        contactEmail: "rejected@example.invalid",
        contactPhone: "+60 3 5555 0999",
        businessAddress: "Rejected registration address",
        firstOutletName: "Rejected Outlet",
        ...overrides,
      },
    });
    assert.equal(
      rejectedRegistration.response.status,
      400,
      `${description}: ${JSON.stringify(rejectedRegistration.data)}`,
    );
    assert.equal(
      typeof rejectedRegistration.data.fieldErrors?.[field],
      "string",
      `${description} should identify the ${field} field`,
    );

    const workspaceAfterInvalidSetup = await db
      .select({
        name: workspacesTable.name,
        contactEmail: workspacesTable.contactEmail,
        contactPhone: workspacesTable.contactPhone,
        businessAddress: workspacesTable.businessAddress,
        setupComplete: workspacesTable.setupComplete,
      })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, newOwner.data.workspace.id));
    const [firstOutletAfterInvalidSetup] = await db
      .select({ name: storeroomsTable.name })
      .from(storeroomsTable)
      .where(eq(storeroomsTable.id, secondRoomId));
    assert.deepEqual(
      workspaceAfterInvalidSetup,
      workspaceProfileBeforeInvalidSetup,
      `${description} changed the workspace profile`,
    );
    assert.equal(
      firstOutletAfterInvalidSetup?.name,
      firstOutletBeforeSetup?.name,
      `${description} changed the first outlet name`,
    );
  }

  const completedWorkspaceSetup = await api(secondOwnerId, "/workspaces/me/setup", {
    method: "PATCH",
    body: {
      name: `  ${fixtureTag} Registered Business  `,
      contactEmail: "  OWNER@EXAMPLE.INVALID  ",
      contactPhone: " +60 3 5555 0303 ",
      businessAddress: " Registered office ",
      firstOutletName: "  Downtown Outlet  ",
    },
  });
  assert.equal(
    completedWorkspaceSetup.response.status,
    200,
    JSON.stringify(completedWorkspaceSetup.data),
  );
  assert.equal(completedWorkspaceSetup.data.name, `${fixtureTag} Registered Business`);
  assert.equal(completedWorkspaceSetup.data.contactEmail, "owner@example.invalid");
  assert.equal(completedWorkspaceSetup.data.contactPhone, "+60 3 5555 0303");
  assert.equal(completedWorkspaceSetup.data.businessAddress, "Registered office");
  assert.equal(completedWorkspaceSetup.data.setupComplete, true);
  assert.equal(completedWorkspaceSetup.data.isOwner, true);

  const [registeredWorkspace] = await db
    .select({
      name: workspacesTable.name,
      contactEmail: workspacesTable.contactEmail,
      contactPhone: workspacesTable.contactPhone,
      businessAddress: workspacesTable.businessAddress,
      setupComplete: workspacesTable.setupComplete,
    })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, newOwner.data.workspace.id));
  assert.deepEqual(registeredWorkspace, {
    name: `${fixtureTag} Registered Business`,
    contactEmail: "owner@example.invalid",
    contactPhone: "+60 3 5555 0303",
    businessAddress: "Registered office",
    setupComplete: true,
  });
  const [registeredFirstOutlet] = await db
    .select({ name: storeroomsTable.name })
    .from(storeroomsTable)
    .where(eq(storeroomsTable.id, secondRoomId));
  assert.equal(registeredFirstOutlet?.name, "Downtown Outlet");
  const firstOutletProfile = await api(secondOwnerId, "/me");
  assert.equal(firstOutletProfile.response.status, 200);
  assert.equal(firstOutletProfile.data.workspace.setupComplete, true);
  assert.deepEqual(
    firstOutletProfile.data.outlets.map(
      ({ id, name }: { id: number; name: string }) => [id, name],
    ),
    [
      [secondRoomId, "Downtown Outlet"],
      [secondOutletId, "Airport Annex"],
    ],
  );

  const staffCannotAddOutlet = await api(secondStaffId, "/outlets", {
    method: "POST",
    body: { name: "Unauthorized Outlet" },
  });
  assert.equal(staffCannotAddOutlet.response.status, 403);
  const staffCannotRenameWorkspace = await api(
    secondStaffId,
    "/workspaces/me",
    {
      method: "PATCH",
      body: { name: `${fixtureTag} Unauthorized Rename` },
    },
  );
  assert.equal(staffCannotRenameWorkspace.response.status, 403);
  const staffCannotUpdateOutletDetails = await api(
    secondStaffId,
    `/outlets/${secondRoomId}`,
    {
      method: "PATCH",
      body: {
        contactEmail: "staff-change@example.invalid",
        contactPhone: null,
        businessAddress: null,
      },
    },
  );
  assert.equal(staffCannotUpdateOutletDetails.response.status, 403);
  const promotedToManager = await api(
    secondOwnerId,
    `/users/${secondStaffId}/role`,
    { method: "PATCH", body: { role: "supervisor" } },
  );
  assert.equal(promotedToManager.response.status, 200);
  const roleChangeEvents = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  const roleChangeEvent = roleChangeEvents.data.find(
    ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
      eventType === "teammate_role_updated" && targetUserId === secondStaffId,
  );
  assert.ok(roleChangeEvent, JSON.stringify(roleChangeEvents.data));
  assert.equal(roleChangeEvent.actorUserId, secondOwnerId);
  assert.equal(roleChangeEvent.actorName, secondOwnerId);
  assert.equal(roleChangeEvent.targetName, secondStaffId);
  assert.equal(roleChangeEvent.storeroomId, secondRoomId);
  assert.deepEqual(roleChangeEvent.changedSections, [
    { section: "role", previousAccess: "staff", newAccess: "supervisor" },
  ]);
  assert.ok(Number.isFinite(Date.parse(roleChangeEvent.createdAt)));
  const roleChangeActivity = await api(
    secondOwnerId,
    "/activity",
    { storeroomId: secondRoomId },
  );
  const roleChangeActivityEvent = roleChangeActivity.data.find(
    (entry: any) =>
      entry.group === "team" &&
      entry.action === "Teammate role changed" &&
      entry.target === secondStaffId,
  );
  assert.ok(roleChangeActivityEvent);
  assert.equal(roleChangeActivityEvent.actor, secondOwnerId);
  assert.match(roleChangeActivityEvent.detail, /Role: staff → supervisor/);
  assert.ok(Number.isFinite(Date.parse(roleChangeActivityEvent.at)));
  const managerUpdatedAssignedOutlet = await api(
    secondStaffId,
    `/outlets/${secondRoomId}`,
    {
      method: "PATCH",
      body: {
        contactEmail: "manager-updated@example.invalid",
        contactPhone: "+60 3 5555 0404",
        businessAddress: "Manager-updated outlet address",
        workspaceName: "Must not change the workspace",
      },
    },
  );
  assert.equal(
    managerUpdatedAssignedOutlet.response.status,
    200,
    JSON.stringify(managerUpdatedAssignedOutlet.data),
  );
  assert.equal(
    managerUpdatedAssignedOutlet.data.contactEmail,
    "manager-updated@example.invalid",
  );
  assert.equal(managerUpdatedAssignedOutlet.data.contactPhone, "+60 3 5555 0404");
  assert.equal(
    managerUpdatedAssignedOutlet.data.businessAddress,
    "Manager-updated outlet address",
  );
  const managerCannotRenameAssignedOutlet = await api(
    secondStaffId,
    `/outlets/${secondRoomId}/name`,
    { method: "PATCH", body: { name: "Manager Renamed Outlet" } },
  );
  assert.equal(managerCannotRenameAssignedOutlet.response.status, 403);
  const managerCannotRenameSiblingOutlet = await api(
    secondStaffId,
    `/outlets/${secondOutletId}/name`,
    { method: "PATCH", body: { name: "Manager Renamed Sibling" } },
  );
  assert.equal(managerCannotRenameSiblingOutlet.response.status, 403);
  const managerCannotUpdateSiblingOutlet = await api(
    secondStaffId,
    `/outlets/${secondOutletId}`,
    {
      method: "PATCH",
      body: {
        contactEmail: "sibling-change@example.invalid",
        contactPhone: null,
        businessAddress: null,
      },
    },
  );
  assert.equal(managerCannotUpdateSiblingOutlet.response.status, 404);
  const managerCannotUpdateWorkspace = await api(secondStaffId, "/workspaces/me", {
    method: "PATCH",
    body: {
      name: `${fixtureTag} Manager Workspace Change`,
      contactEmail: "manager-workspace@example.invalid",
      contactPhone: "+60 3 5555 0405",
      businessAddress: "Manager workspace address",
    },
  });
  assert.equal(managerCannotUpdateWorkspace.response.status, 403);
  const profilesAfterManagerUpdate = await api(secondOwnerId, "/me");
  assert.equal(
    profilesAfterManagerUpdate.data.workspace.name,
    `${fixtureTag} Registered Business`,
  );
  assert.equal(
    profilesAfterManagerUpdate.data.workspace.contactEmail,
    "owner@example.invalid",
  );
  assert.equal(
    profilesAfterManagerUpdate.data.workspace.contactPhone,
    "+60 3 5555 0303",
  );
  assert.equal(
    profilesAfterManagerUpdate.data.workspace.businessAddress,
    "Registered office",
  );
  assert.equal(
    profilesAfterManagerUpdate.data.outlets.find(
      ({ id }: { id: number }) => id === secondRoomId,
    )?.contactEmail,
    "manager-updated@example.invalid",
  );
  assert.equal(
    profilesAfterManagerUpdate.data.outlets.find(
      ({ id }: { id: number }) => id === secondOutletId,
    )?.contactEmail,
    "new-airport@example.invalid",
  );
  const managerAddedStaff = await api(secondStaffId, "/users", {
    method: "POST",
    body: {
      email: `${secondManagerInviteeId}@example.invalid`,
      role: "staff",
    },
  });
  assert.equal(managerAddedStaff.response.status, 201, JSON.stringify(managerAddedStaff.data));
  const managerCannotAddAdmin = await api(secondStaffId, "/users", {
    method: "POST",
    body: {
      email: `${secondManagerInviteeId}@example.invalid`,
      role: "admin",
    },
  });
  assert.equal(managerCannotAddAdmin.response.status, 403);
  const managerInvitationList = await api(secondStaffId, "/users/invitations");
  assert.equal(managerInvitationList.response.status, 200);
  const emailInvitationsDisabled = await api(secondStaffId, "/users/invitations", {
    method: "POST",
    body: {
      name: "Elevated Role Check",
      email: `${fixtureTag}-elevated@example.invalid`,
      role: "admin",
    },
  });
  assert.equal(emailInvitationsDisabled.response.status, 410);

  const ownerResetStaff = await api(
    legacyOwnerId,
    `/users/${legacyStaffId}/password-reset`,
    { method: "POST", storeroomId: legacyRoomId },
  );
  assert.equal(ownerResetStaff.response.status, 201);
  assert.equal(ownerResetStaff.data.resetToken.length, 43);
  assert.ok(Date.parse(ownerResetStaff.data.expiresAt) > Date.now());
  assert.ok(
    Date.parse(ownerResetStaff.data.expiresAt) <= Date.now() + 30 * 60 * 1000,
  );
  const [storedResetToken] = await db
    .select({ tokenHash: passwordResetTokensTable.tokenHash })
    .from(passwordResetTokensTable)
    .where(eq(passwordResetTokensTable.targetUserId, legacyStaffId));
  assert.equal(storedResetToken?.tokenHash.length, 64);
  assert.notEqual(storedResetToken?.tokenHash, ownerResetStaff.data.resetToken);

  const staffCannotResetAccounts = await api(
    legacyStaffId,
    `/users/${legacyOwnerId}/password-reset`,
    { method: "POST", storeroomId: legacyRoomId },
  );
  assert.equal(staffCannotResetAccounts.response.status, 403);

  const ownerCannotResetOtherOutletStaff = await api(
    legacyOwnerId,
    `/users/${secondStaffId}/password-reset`,
    { method: "POST", storeroomId: legacyRoomId },
  );
  assert.equal(ownerCannotResetOtherOutletStaff.response.status, 404);

  const managerResetStaff = await api(
    secondStaffId,
    `/users/${secondManagerInviteeId}/password-reset`,
    { method: "POST", storeroomId: secondRoomId },
  );
  assert.equal(managerResetStaff.response.status, 201);
  const managerResetOwner = await api(
    secondStaffId,
    `/users/${secondOwnerId}/password-reset`,
    { method: "POST", storeroomId: secondRoomId },
  );
  assert.equal(managerResetOwner.response.status, 403);

  const legacySecurityEvents = await api(
    legacyOwnerId,
    "/users/security-events",
    { storeroomId: legacyRoomId },
  );
  assert.equal(legacySecurityEvents.response.status, 200);
  assert.equal(legacySecurityEvents.data.length, 1);
  assert.equal(legacySecurityEvents.data[0].targetName, legacyStaffId);
  assert.equal(legacySecurityEvents.data[0].actorName, legacyOwnerId);
  assert.equal(legacySecurityEvents.data[0].eventType, "password_reset_link_created");

  const outletSecurityEvents = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  assert.equal(outletSecurityEvents.response.status, 200);
  assert.ok(
    outletSecurityEvents.data.some(
      ({ eventType, targetName }: { eventType: string; targetName: string }) =>
        eventType === "password_reset_link_created" &&
        targetName === secondManagerInviteeId,
    ),
    JSON.stringify(outletSecurityEvents.data),
  );

  const managerStaffAccess = {
    dashboard: "view",
    receiving: "edit",
    deliveryRecords: "view",
    products: "none",
    suppliers: "view",
    stockTransfers: "none",
    purchaseOrders: "edit",
    approvals: "view",
    activity: "view",
    stockCount: "edit",
  };
  const managerAccessUpdate = await api(
    secondStaffId,
    `/users/${secondManagerInviteeId}/access`,
    {
      method: "PATCH",
      storeroomId: secondRoomId,
      body: { access: managerStaffAccess },
    },
  );
  assert.equal(
    managerAccessUpdate.response.status,
    200,
    JSON.stringify(managerAccessUpdate.data),
  );
  const managerSecurityEvents = await api(
    secondStaffId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  assert.equal(managerSecurityEvents.response.status, 200);
  const managerAccessEvent = managerSecurityEvents.data.find(
    ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
      eventType === "staff_access_updated" &&
      targetUserId === secondManagerInviteeId,
  );
  assert.ok(managerAccessEvent, JSON.stringify(managerSecurityEvents.data));
  assert.equal(managerAccessEvent.actorUserId, secondStaffId);
  assert.equal(managerAccessEvent.actorName, secondStaffId);
  assert.equal(managerAccessEvent.targetUserId, secondManagerInviteeId);
  assert.equal(managerAccessEvent.targetName, secondManagerInviteeId);
  assert.equal(managerAccessEvent.storeroomId, secondRoomId);
  assert.equal(managerAccessEvent.outletName, "Main Outlet");
  assert.deepEqual(managerAccessEvent.changedSections, [
    { section: "products", previousAccess: "view", newAccess: "none" },
  ]);
  assert.ok(Number.isFinite(Date.parse(managerAccessEvent.createdAt)));

  const siblingAccessBeforeRejectedUpdate = await api(
    secondOwnerId,
    "/users",
    { storeroomId: secondOutletId },
  );
  assert.equal(siblingAccessBeforeRejectedUpdate.response.status, 200);
  const siblingStaffBeforeRejectedUpdate = siblingAccessBeforeRejectedUpdate.data.find(
    ({ id }: { id: string }) => id === secondOutletStaffId,
  );
  assert.ok(siblingStaffBeforeRejectedUpdate);
  const siblingEventsBeforeRejectedUpdate = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondOutletId },
  );
  assert.equal(siblingEventsBeforeRejectedUpdate.response.status, 200);
  const managerEventsBeforeRejectedUpdate = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  assert.equal(managerEventsBeforeRejectedUpdate.response.status, 200);

  const managerCannotUpdateSiblingStaffAccess = await api(
    secondStaffId,
    `/users/${secondOutletStaffId}/access`,
    {
      method: "PATCH",
      storeroomId: secondOutletId,
      body: { access: managerStaffAccess },
    },
  );
  assert.equal(
    managerCannotUpdateSiblingStaffAccess.response.status,
    404,
    JSON.stringify(managerCannotUpdateSiblingStaffAccess.data),
  );

  const siblingAccessAfterRejectedUpdate = await api(
    secondOwnerId,
    "/users",
    { storeroomId: secondOutletId },
  );
  assert.equal(siblingAccessAfterRejectedUpdate.response.status, 200);
  const siblingStaffAfterRejectedUpdate = siblingAccessAfterRejectedUpdate.data.find(
    ({ id }: { id: string }) => id === secondOutletStaffId,
  );
  assert.deepEqual(
    siblingStaffAfterRejectedUpdate?.access,
    siblingStaffBeforeRejectedUpdate.access,
    "A manager's rejected cross-outlet request must not change the teammate's permissions.",
  );
  const siblingEventsAfterRejectedUpdate = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondOutletId },
  );
  assert.equal(siblingEventsAfterRejectedUpdate.response.status, 200);
  assert.deepEqual(
    siblingEventsAfterRejectedUpdate.data.map(({ id }: { id: number }) => id),
    siblingEventsBeforeRejectedUpdate.data.map(({ id }: { id: number }) => id),
    "A rejected cross-outlet request must not add a security event to the sibling outlet.",
  );
  const managerEventsAfterRejectedUpdate = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  assert.equal(managerEventsAfterRejectedUpdate.response.status, 200);
  assert.deepEqual(
    managerEventsAfterRejectedUpdate.data.map(({ id }: { id: number }) => id),
    managerEventsBeforeRejectedUpdate.data.map(({ id }: { id: number }) => id),
    "A rejected cross-outlet request must not add a security event to the manager's outlet.",
  );

  const managerCannotReviewUnassignedOutlet = await api(
    secondStaffId,
    "/users/security-events",
    { storeroomId: legacyRoomId },
  );
  assert.equal(managerCannotReviewUnassignedOutlet.response.status, 404);

  const staffCannotViewSecurityEvents = await api(
    legacyStaffId,
    "/users/security-events",
    { storeroomId: legacyRoomId },
  );
  assert.equal(staffCannotViewSecurityEvents.response.status, 403);

  const legacyProducts = await api(legacyOwnerId, "/products");
  assert.equal(legacyProducts.response.status, 200);
  assert.equal(legacyProducts.data.length, 1);
  const legacyBatches = await api(legacyOwnerId, "/inventory/batches");
  assert.equal(legacyBatches.data.length, 1);
  const legacyMovements = await api(legacyOwnerId, "/inventory/movements");
  assert.equal(legacyMovements.data.length, 1);
  assert.equal((await api(legacyOwnerId, "/purchase-orders")).data.length, 1);
  assert.equal((await api(legacyOwnerId, "/stock-counts")).data.length, 1);

  const productA = await createProduct(legacyOwnerId, `${fixtureTag}-room-a-product`);
  const productB = await createProduct(secondOwnerId, `${fixtureTag}-room-b-product`);
  const catalogueHistoryProduct = await createProduct(
    legacyOwnerId,
    `${fixtureTag}-catalogue-history-product`,
    legacyRoomId,
  );
  const catalogueProductUpdate = await api(
    legacyOwnerId,
    `/products/${catalogueHistoryProduct.id}`,
    {
      method: "PATCH",
      storeroomId: legacyRoomId,
      body: { minStock: 3 },
    },
  );
  assert.equal(catalogueProductUpdate.response.status, 200);
  const catalogueProductArchive = await api(
    legacyOwnerId,
    `/products/${catalogueHistoryProduct.id}`,
    {
      method: "PATCH",
      storeroomId: legacyRoomId,
      body: { active: false },
    },
  );
  assert.equal(catalogueProductArchive.response.status, 200);
  const catalogueProductActivity = await api(
    legacyOwnerId,
    "/activity",
    { storeroomId: legacyRoomId },
  );
  assert.equal(catalogueProductActivity.response.status, 200);
  const productEvents = catalogueProductActivity.data.filter(
    (entry: any) => entry.group === "catalogue" && entry.target === catalogueHistoryProduct.name,
  );
  assert.deepEqual(
    productEvents.map((entry: any) => entry.action).sort(),
    ["Product added", "Product archived", "Product updated"].sort(),
  );
  const productCreatedEvent = productEvents.find(
    (entry: any) => entry.action === "Product added",
  );
  assert.equal(productCreatedEvent.actor, legacyOwnerId);
  assert.ok(Number.isFinite(Date.parse(productCreatedEvent.at)));
  assert.match(productCreatedEvent.detail, /Added fields: .*Name.*Category/);
  assert.ok(
    productEvents.some((entry: any) =>
      entry.action === "Product updated" && entry.detail.includes("Low-stock threshold"),
    ),
  );
  assert.ok(
    productEvents.some((entry: any) =>
      entry.action === "Product archived" && entry.detail.includes("Active status"),
    ),
  );
  const siblingProductActivity = await api(
    secondOwnerId,
    "/activity",
    { storeroomId: secondRoomId },
  );
  assert.ok(
    !siblingProductActivity.data.some(
      (entry: any) => entry.target === catalogueHistoryProduct.name,
    ),
    "Product catalogue history must not leak into another outlet's Activity.",
  );
  const roomARecords = await createRoomData(legacyOwnerId, productA.id);
  const roomBRecords = await createRoomData(secondOwnerId, productB.id);

  for (const [userId, ownRoomId, ownProduct, otherProduct, ownRecords, otherRecords] of [
    [legacyOwnerId, legacyRoomId, productA, productB, roomARecords, roomBRecords],
    [secondOwnerId, secondRoomId, productB, productA, roomBRecords, roomARecords],
  ] as const) {
    const productList = await api(userId, "/products", { storeroomId: ownRoomId });
    assert.equal(productList.response.status, 200);
    assert.ok(productList.data.some(({ id }: { id: number }) => id === ownProduct.id));
    assert.ok(!productList.data.some(({ id }: { id: number }) => id === otherProduct.id));

    const crossRoomHint = await api(
      userId,
      `/products/${otherProduct.id}`,
      { storeroomId: ownRoomId === legacyRoomId ? secondRoomId : legacyRoomId },
    );
    assert.equal(crossRoomHint.response.status, 404);

    const crossRoomUpdate = await api(userId, `/products/${otherProduct.id}`, {
      method: "PATCH",
      storeroomId: ownRoomId,
      body: { name: `${fixtureTag}-should-not-update` },
    });
    assert.equal(crossRoomUpdate.response.status, 404);

    const crossRoomAdjustment = await api(userId, "/inventory/adjustments", {
      method: "POST",
      storeroomId: ownRoomId,
      body: {
        productId: otherProduct.id,
        quantityDelta: 99,
        reason: "Cross-room write attempt",
      },
    });
    assert.equal(crossRoomAdjustment.response.status, 404);

    const crossRoomOrder = await api(userId, "/purchase-orders", {
      method: "POST",
      storeroomId: ownRoomId,
      body: { lines: [{ productId: otherProduct.id, quantity: 3 }] },
    });
    assert.equal(crossRoomOrder.response.status, 400);

    const ownOrders = await api(userId, "/purchase-orders", { storeroomId: ownRoomId });
    const ownCounts = await api(userId, "/stock-counts", { storeroomId: ownRoomId });
    const ownMovements = await api(userId, "/inventory/movements", { storeroomId: ownRoomId });
    const ownBatches = await api(userId, "/inventory/batches", { storeroomId: ownRoomId });
    const ownActivity = await api(userId, "/activity", { storeroomId: ownRoomId });
    assert.equal(ownActivity.response.status, 200);
    assert.ok(ownActivity.data.some((entry: any) => entry.group === "orders" && entry.action === "Order drafted"));
    assert.ok(ownActivity.data.some((entry: any) => entry.group === "stock" && entry.action === "Stock count started"));
    assert.ok(
      !ownActivity.data.some((entry: any) =>
        `${entry.target ?? ""} ${entry.detail ?? ""}`.includes(otherProduct.name),
      ),
      "Activity must not disclose another outlet's product history.",
    );
    assert.ok(ownOrders.data.some(({ id }: { id: number }) => id === ownRecords.orderId));
    assert.ok(!ownOrders.data.some(({ id }: { id: number }) => id === otherRecords.orderId));
    const ownOrderHistoryExport = await api(userId, "/purchase-orders/history/export", {
      storeroomId: ownRoomId,
    });
    assert.equal(ownOrderHistoryExport.response.status, 200);
    assert.ok(ownOrderHistoryExport.data.some((entry: any) =>
      entry.orderId === ownRecords.orderId &&
      typeof entry.actor === "string" &&
      typeof entry.action === "string" &&
      typeof entry.status === "string" &&
      typeof entry.createdAt === "string",
    ), "The export includes order, actor, action, status, and timestamp.");
    assert.ok(
      !ownOrderHistoryExport.data.some((entry: any) => entry.orderId === otherRecords.orderId),
      "Purchase-order history exports must not disclose another outlet's events.",
    );
    const historyDay = new Date(ownOrderHistoryExport.data[0].createdAt).toISOString().slice(0, 10);
    const dateFilteredHistory = await api(
      userId,
      `/purchase-orders/history/export?startDate=${historyDay}&endDate=${historyDay}`,
      { storeroomId: ownRoomId },
    );
    assert.equal(dateFilteredHistory.response.status, 200);
    assert.ok(dateFilteredHistory.data.length > 0);
    assert.ok(dateFilteredHistory.data.every((entry: any) =>
      new Date(entry.createdAt).toISOString().slice(0, 10) === historyDay,
    ), "Date filters include the selected UTC calendar day only.");
    const selectedStatus = ownOrderHistoryExport.data[0].status;
    const statusFilteredHistory = await api(
      userId,
      `/purchase-orders/history/export?status=${selectedStatus}`,
      { storeroomId: ownRoomId },
    );
    assert.equal(statusFilteredHistory.response.status, 200);
    assert.ok(statusFilteredHistory.data.length > 0);
    assert.ok(statusFilteredHistory.data.every((entry: any) => entry.status === selectedStatus));
    assert.equal(
      (await api(userId, "/purchase-orders/history/export?startDate=2026-11-10&endDate=2026-11-09", {
        storeroomId: ownRoomId,
      })).response.status,
      400,
      "The export rejects reversed date ranges.",
    );
    assert.equal(
      (await api(userId, "/purchase-orders/history/export?startDate=2026-02-30", {
        storeroomId: ownRoomId,
      })).response.status,
      400,
      "The export rejects invalid calendar dates.",
    );
    assert.ok(ownCounts.data.some(({ id }: { id: number }) => id === ownRecords.countId));
    assert.ok(!ownCounts.data.some(({ id }: { id: number }) => id === otherRecords.countId));
    assert.ok(
      ownMovements.data.some(
        ({ productId }: { productId: number }) => productId === ownProduct.id,
      ),
    );
    assert.ok(
      !ownMovements.data.some(
        ({ productId }: { productId: number }) => productId === otherProduct.id,
      ),
    );
    assert.ok(
      ownBatches.data.some(
        ({ productId }: { productId: number }) => productId === ownProduct.id,
      ),
    );
    assert.ok(
      !ownBatches.data.some(
        ({ productId }: { productId: number }) => productId === otherProduct.id,
      ),
    );

    const crossOutletHistory = await api(
      userId,
      `/purchase-orders/${otherRecords.orderId}/history`,
      { storeroomId: ownRoomId },
    );
    assert.equal(crossOutletHistory.response.status, 404);

    assert.equal(
      (await api(userId, `/purchase-orders/${otherRecords.orderId}/decision`, {
        method: "POST",
        storeroomId: ownRoomId,
        body: { decision: "approved" },
      })).response.status,
      404,
    );
    assert.equal(
      (await api(userId, `/purchase-orders/${otherRecords.orderId}/receipts`, {
        method: "POST",
        storeroomId: ownRoomId,
        body: { lines: [{ productId: otherProduct.id, receivedQuantity: 1 }] },
      })).response.status,
      404,
    );
    assert.equal(
      (await api(userId, `/stock-counts/${otherRecords.countId}`, {
        storeroomId: ownRoomId,
      })).response.status,
      404,
    );
    assert.equal(
      (await api(userId, `/stock-counts/${otherRecords.countId}/submit`, {
        method: "POST",
        storeroomId: ownRoomId,
        body: {
          lines: [{ productId: otherProduct.id, countedQuantity: 0 }],
          acknowledgedMovementIds: [],
        },
      })).response.status,
      404,
    );
    assert.equal(
      (await api(userId, `/stock-counts/${otherRecords.countId}/workbook`, {
        storeroomId: ownRoomId,
      })).response.status,
      404,
      "A count workbook cannot be downloaded from another outlet.",
    );
    assert.equal(
      (await api(userId, `/stock-counts/${otherRecords.countId}/workbook/upload-url`, {
        method: "POST",
        storeroomId: ownRoomId,
        body: {
          name: "stock-count.xlsx",
          size: 1024,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      })).response.status,
      404,
      "An upload URL cannot be requested for another outlet's count.",
    );

    // New purchase-order requests wait for an owner or manager to approve them.
    const approvedOrder = await api(
      userId,
      `/purchase-orders/${ownRecords.orderId}/decision`,
      {
        method: "POST",
        storeroomId: ownRoomId,
        body: { decision: "approved" },
      },
    );
    assert.equal(approvedOrder.response.status, 200);
    const ownReceipt = await api(
      userId,
      `/purchase-orders/${ownRecords.orderId}/receipts`,
      {
        method: "POST",
        storeroomId: ownRoomId,
        body: {
          lines: [{ productId: ownProduct.id, receivedQuantity: 1 }],
        },
      },
    );
    assert.equal(ownReceipt.response.status, 200);
    const ownHistory = await api(
      userId,
      `/purchase-orders/${ownRecords.orderId}/history`,
      { storeroomId: ownRoomId },
    );
    assert.equal(ownHistory.response.status, 200);
    assert.ok(
      ownHistory.data.some((event: any) =>
        event.action === "Request approved" &&
        event.actor &&
        Number.isFinite(Date.parse(event.createdAt)),
      ),
      "The outlet history should show who approved the order and when.",
    );
    assert.ok(
      ownHistory.data.some((event: any) =>
        event.action ===
          (ownReceipt.data.status === "received"
            ? "Order fully received"
            : "Order partially received") &&
        event.status === ownReceipt.data.status,
      ),
      "The outlet history should record the resulting receipt status.",
    );

    const ownCount = await api(userId, `/stock-counts/${ownRecords.countId}`, {
      storeroomId: ownRoomId,
    });
    assert.equal(ownCount.response.status, 200);
    assert.equal(ownCount.data.workbook, null);
    assert.equal(
      (await api(userId, `/stock-counts/${ownRecords.countId}/workbook`, {
        storeroomId: ownRoomId,
      })).response.status,
      404,
    );
    const workbookName = `${fixtureTag}-stock-count.xlsx`;
    const workbookContentType =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const workbookBytes = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00,
      ...Buffer.from(`${fixtureTag}-storage-backed-workbook`),
    ]);
    let workbookObjectPath: string | undefined;
    if (userId === legacyOwnerId) {
      const uploadDetails = await api(
        userId,
        `/stock-counts/${ownRecords.countId}/workbook/upload-url`,
        {
          method: "POST",
          storeroomId: ownRoomId,
          body: {
            name: workbookName,
            size: workbookBytes.byteLength,
            contentType: workbookContentType,
          },
        },
      );
      assert.equal(uploadDetails.response.status, 200, JSON.stringify(uploadDetails.data));
      workbookObjectPath = uploadDetails.data.objectPath;
      assert.equal(typeof workbookObjectPath, "string");
      fixtureWorkbookObjectPaths.push(workbookObjectPath!);
      const uploadResponse = await fetch(uploadDetails.data.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": workbookContentType },
        body: workbookBytes,
      });
      assert.equal(
        uploadResponse.status,
        200,
        `Workbook upload failed with ${uploadResponse.status}: ${await uploadResponse.text()}`,
      );
    }

    const submittedCount = await api(
      userId,
      `/stock-counts/${ownRecords.countId}/submit`,
      {
        method: "POST",
        storeroomId: ownRoomId,
        body: {
          lines: ownCount.data.lines.map(
            ({
              productId,
              expectedQuantity,
              sectionId,
            }: {
              productId: number;
              expectedQuantity: number;
              sectionId: number | null;
            }) => ({
              productId,
              sectionId: sectionId ?? undefined,
              countedQuantity: expectedQuantity,
            }),
          ),
          acknowledgedMovementIds: ownCount.data.movements.map(
            ({ id }: { id: number }) => id,
          ),
          ...(workbookObjectPath
            ? { workbookObjectPath, workbookName }
            : {}),
        },
      },
    );
    assert.equal(submittedCount.response.status, 200);
    if (workbookObjectPath) {
      assert.deepEqual(submittedCount.data.workbook, {
        name: workbookName,
        uploadedBy: userId,
        submittedAt: submittedCount.data.workbook.submittedAt,
      });
      assert.ok(Number.isFinite(Date.parse(submittedCount.data.workbook.submittedAt)));

      const persistedCount = await api(
        userId,
        `/stock-counts/${ownRecords.countId}`,
        { storeroomId: ownRoomId },
      );
      assert.equal(persistedCount.response.status, 200);
      assert.equal(persistedCount.data.workbook.name, workbookName);
      assert.equal(persistedCount.data.workbook.uploadedBy, userId);
      assert.equal(
        persistedCount.data.workbook.submittedAt,
        submittedCount.data.workbook.submittedAt,
      );

      const workbookDownload = await fetch(
        `${baseUrl}/api/stock-counts/${ownRecords.countId}/workbook`,
        {
          headers: {
            "x-test-user-id": userId,
            "x-storeroom-id": String(ownRoomId),
          },
        },
      );
      assert.equal(workbookDownload.status, 200);
      assert.ok(
        workbookDownload.headers
          .get("content-disposition")
          ?.includes(`filename*=UTF-8''${encodeURIComponent(workbookName)}`),
        "The download should use the original workbook filename.",
      );
      assert.deepEqual(
        Buffer.from(await workbookDownload.arrayBuffer()),
        workbookBytes,
        "The downloaded workbook should contain the original uploaded bytes.",
      );

      const otherOutletDownload = await api(
        secondStaffId,
        `/stock-counts/${ownRecords.countId}/workbook`,
        { storeroomId: secondRoomId },
      );
      assert.equal(
        otherOutletDownload.response.status,
        404,
        "A teammate in another outlet cannot download this workbook.",
      );
    }

    const teams = await api(userId, "/users", { storeroomId: ownRoomId });
    assert.equal(teams.response.status, 200, JSON.stringify(teams.data));
    const expectedStaffId = userId === legacyOwnerId ? legacyStaffId : secondStaffId;
    assert.ok(teams.data.some(({ id }: { id: string }) => id === expectedStaffId));
    assert.ok(!teams.data.some(({ id }: { id: string }) => id === (userId === legacyOwnerId ? secondStaffId : legacyStaffId)));

    const ownProductUpdate = await api(userId, `/products/${ownProduct.id}`, {
      method: "PATCH",
      storeroomId: ownRoomId,
      body: { name: `${ownProduct.name}-updated` },
    });
    assert.equal(ownProductUpdate.response.status, 200);
    assert.equal(ownProductUpdate.data.name, `${ownProduct.name}-updated`);
  }

  const wrongTeamUpdate = await api(legacyOwnerId, `/users/${secondStaffId}/role`, {
    method: "PATCH",
    storeroomId: legacyRoomId,
    body: { role: "supervisor" },
  });
  assert.equal(wrongTeamUpdate.response.status, 404);

  const updatedProductA = await api(legacyOwnerId, `/products/${productA.id}`, {
    storeroomId: legacyRoomId,
  });
  assert.equal(updatedProductA.response.status, 200);
  assert.equal(updatedProductA.data.name, `${productA.name}-updated`);
  const updatedProductB = await api(secondOwnerId, `/products/${productB.id}`, {
    storeroomId: secondRoomId,
  });
  assert.equal(updatedProductB.data.name, `${productB.name}-updated`);

  const staffRead = await api(legacyStaffId, "/products", { storeroomId: legacyRoomId });
  assert.equal(staffRead.response.status, 200);
  assert.ok(!staffRead.data.some(({ id }: { id: number }) => id === productB.id));
  // These fixture accounts need explicit edit access to test same-outlet stock writes.
  await db
    .update(storeroomMembershipsTable)
    .set({ permissions: { products: "edit" } })
    .where(inArray(storeroomMembershipsTable.userId, [legacyStaffId, secondStaffId]));
  const staffOwnWrite = await api(legacyStaffId, "/inventory/adjustments", {
    method: "POST",
    storeroomId: legacyRoomId,
    body: {
      productId: productA.id,
      quantityDelta: 2,
      reason: "Staff update in authorized storeroom",
    },
  });
  assert.equal(staffOwnWrite.response.status, 201);
  const staffCrossRoomWrite = await api(legacyStaffId, "/inventory/adjustments", {
    method: "POST",
    storeroomId: legacyRoomId,
    body: {
      productId: productB.id,
      quantityDelta: 55,
      reason: "Cross-room staff attempt",
    },
  });
  assert.equal(staffCrossRoomWrite.response.status, 404);
  const secondStaffOwnWrite = await api(secondStaffId, "/inventory/adjustments", {
    method: "POST",
    storeroomId: secondRoomId,
    body: {
      productId: productB.id,
      quantityDelta: 2,
      reason: "Staff update in authorized storeroom",
    },
  });
  assert.equal(secondStaffOwnWrite.response.status, 201);
  const secondStaffCrossRoomWrite = await api(
    secondStaffId,
    "/inventory/adjustments",
    {
      method: "POST",
      storeroomId: secondRoomId,
      body: {
        productId: productA.id,
        quantityDelta: 55,
        reason: "Cross-room staff attempt",
      },
    },
  );
  assert.equal(secondStaffCrossRoomWrite.response.status, 404);
  const staffTeamRead = await api(legacyStaffId, "/users", {
    storeroomId: legacyRoomId,
  });
  assert.equal(staffTeamRead.response.status, 403);

  const staffAccess = {
    dashboard: "view",
    receiving: "edit",
    deliveryRecords: "view",
    products: "none",
    suppliers: "view",
    stockTransfers: "none",
    purchaseOrders: "edit",
    approvals: "view",
    activity: "view",
    stockCount: "edit",
  };
  const accessUpdate = await api(
    legacyOwnerId,
    `/users/${legacyStaffId}/access`,
    { method: "PATCH", storeroomId: legacyRoomId, body: { access: staffAccess } },
  );
  assert.equal(accessUpdate.response.status, 200, JSON.stringify(accessUpdate.data));
  const accessEvents = await api(legacyOwnerId, "/users/security-events", {
    storeroomId: legacyRoomId,
  });
  assert.equal(accessEvents.response.status, 200);
  const accessEvent = accessEvents.data.find(
    ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
      eventType === "staff_access_updated" && targetUserId === legacyStaffId,
  );
  assert.ok(accessEvent, JSON.stringify(accessEvents.data));
  assert.equal(accessEvent.actorUserId, legacyOwnerId);
  assert.equal(accessEvent.actorName, legacyOwnerId);
  assert.equal(accessEvent.targetName, legacyStaffId);
  assert.equal(accessEvent.storeroomId, legacyRoomId);
  assert.equal(accessEvent.outletName, "Main Outlet");
  assert.deepEqual(accessEvent.changedSections, [
    { section: "products", previousAccess: "edit", newAccess: "none" },
  ]);
  assert.ok(Number.isFinite(Date.parse(accessEvent.createdAt)));

  const unchangedAccessUpdate = await api(
    legacyOwnerId,
    `/users/${legacyStaffId}/access`,
    { method: "PATCH", storeroomId: legacyRoomId, body: { access: staffAccess } },
  );
  assert.equal(unchangedAccessUpdate.response.status, 200);
  const repeatedAccessEvents = await api(
    legacyOwnerId,
    "/users/security-events",
    { storeroomId: legacyRoomId },
  );
  assert.equal(
    repeatedAccessEvents.data.filter(
      ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
        eventType === "staff_access_updated" && targetUserId === legacyStaffId,
    ).length,
    1,
  );
  const otherOutletAccessEvents = await api(
    secondOwnerId,
    "/users/security-events",
    { storeroomId: secondRoomId },
  );
  assert.ok(
    !otherOutletAccessEvents.data.some(
      ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
        eventType === "staff_access_updated" && targetUserId === legacyStaffId,
    ),
  );
  const crossOutletAccessUpdate = await api(
    legacyOwnerId,
    `/users/${secondStaffId}/access`,
    { method: "PATCH", storeroomId: legacyRoomId, body: { access: staffAccess } },
  );
  assert.equal(crossOutletAccessUpdate.response.status, 404);

  const lowStockProduct = await api(legacyOwnerId, `/products/${productA.id}`, {
    method: "PATCH",
    storeroomId: legacyRoomId,
    body: { minStock: 21 },
  });
  assert.equal(lowStockProduct.response.status, 200, JSON.stringify(lowStockProduct.data));
  const adequatelyStockedProduct = await api(
    secondOwnerId,
    `/products/${productB.id}`,
    {
      method: "PATCH",
      storeroomId: secondRoomId,
      body: { minStock: 10 },
    },
  );
  assert.equal(
    adequatelyStockedProduct.response.status,
    200,
    JSON.stringify(adequatelyStockedProduct.data),
  );

  const dashboardActivityA = `${fixtureTag}-room-a-dashboard-activity`;
  const dashboardActivityB = `${fixtureTag}-room-b-dashboard-activity`;
  for (const [userId, roomId, productId, reason, quantityDelta] of [
    [legacyOwnerId, legacyRoomId, productA.id, dashboardActivityA, 1],
    [secondOwnerId, secondRoomId, productB.id, dashboardActivityB, 4],
  ] as const) {
    const adjustment = await api(userId, "/inventory/adjustments", {
      method: "POST",
      storeroomId: roomId,
      body: { productId, quantityDelta, reason },
    });
    assert.equal(adjustment.response.status, 201, JSON.stringify(adjustment.data));
  }

  const dashboardMovementReasons = Array.from(
    { length: 8 },
    (_, index) => `${fixtureTag}-room-a-dashboard-movement-${index}`,
  );
  const dashboardMovementStart = Date.UTC(2099, 0, 1);
  await db.insert(stockMovementsTable).values(
    dashboardMovementReasons.map((reason, index) => ({
      productId: productA.id,
      type: "adjustment" as const,
      quantityDelta: index + 1,
      reason,
      actor: legacyOwnerId,
      occurredAt: new Date(dashboardMovementStart + index * 1_000),
    })),
  );

  const expiryDate = (daysFromToday: number) => {
    const today = new Date().toISOString().slice(0, 10);
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + daysFromToday);
    return date.toISOString().slice(0, 10);
  };
  await db.insert(stockBatchesTable).values({
    productId: productA.id,
    quantity: 1,
    expiryDate: expiryDate(0),
    createdBy: legacyOwnerId,
  });
  const dashboardWithTodayExpiry = await api(
    legacyOwnerId,
    "/dashboard/summary",
    { storeroomId: legacyRoomId },
  );
  assert.equal(
    dashboardWithTodayExpiry.data.expiringSoonCount,
    1,
    "Dashboard summary must count a positive batch expiring today.",
  );

  await db.insert(stockBatchesTable).values({
    productId: productA.id,
    quantity: 1,
    expiryDate: expiryDate(7),
    createdBy: legacyOwnerId,
  });
  const dashboardWithSeventhDayExpiry = await api(
    legacyOwnerId,
    "/dashboard/summary",
    { storeroomId: legacyRoomId },
  );
  assert.equal(
    dashboardWithSeventhDayExpiry.data.expiringSoonCount,
    2,
    "Dashboard summary must count a positive batch expiring exactly seven days from today.",
  );

  await db.insert(stockBatchesTable).values([
    {
      productId: productA.id,
      quantity: 1,
      expiryDate: expiryDate(3),
      createdBy: legacyOwnerId,
    },
    {
      productId: productA.id,
      quantity: 0,
      expiryDate: expiryDate(3),
      createdBy: legacyOwnerId,
    },
    {
      productId: productA.id,
      quantity: 1,
      expiryDate: expiryDate(-1),
      createdBy: legacyOwnerId,
    },
    {
      productId: productA.id,
      quantity: 1,
      expiryDate: expiryDate(8),
      createdBy: legacyOwnerId,
    },
  ]);

  for (const [userId, roomId, productId, requestCount] of [
    [legacyOwnerId, legacyRoomId, productA.id, 2],
    [secondOwnerId, secondRoomId, productB.id, 1],
  ] as const) {
    for (let index = 0; index < requestCount; index += 1) {
      const pendingRequest = await api(userId, "/purchase-orders", {
        method: "POST",
        storeroomId: roomId,
        body: {
          lines: [{ productId, quantity: index + 1 }],
          note: `${fixtureTag}-pending-${roomId}-${index}`,
        },
      });
      assert.equal(pendingRequest.response.status, 201, JSON.stringify(pendingRequest.data));
      fixtureOrderIds.push(pendingRequest.data.id);
      await db
        .update(purchaseOrdersTable)
        .set({ status: "pending" })
        .where(eq(purchaseOrdersTable.id, pendingRequest.data.id));
    }
  }

  const dashboardA = await api(legacyOwnerId, "/dashboard/summary", {
    storeroomId: legacyRoomId,
  });
  const dashboardBatchesA = await api(legacyOwnerId, "/inventory/batches", {
    storeroomId: legacyRoomId,
  });
  const dashboardB = await api(secondOwnerId, "/dashboard/summary", {
    storeroomId: secondRoomId,
  });
  assert.equal(dashboardA.response.status, 200, JSON.stringify(dashboardA.data));
  assert.equal(dashboardBatchesA.response.status, 200, JSON.stringify(dashboardBatchesA.data));
  assert.equal(dashboardB.response.status, 200, JSON.stringify(dashboardB.data));
  const today = new Date().toISOString().slice(0, 10);
  const radarWindowEnd = new Date(`${today}T00:00:00.000Z`);
  radarWindowEnd.setUTCDate(radarWindowEnd.getUTCDate() + 7);
  const lastDay = radarWindowEnd.toISOString().slice(0, 10);
  assert.equal(
    dashboardBatchesA.data.filter(
      ({ quantity, expiryDate }: { quantity: number; expiryDate?: string | null }) => {
        const expiryDay = expiryDate?.slice(0, 10);
        return quantity > 0 && Boolean(expiryDay) && expiryDay! >= today && expiryDay! <= lastDay;
      },
    ).length,
    dashboardA.data.expiringSoonCount,
    "Expiry radar batches must match the dashboard summary for the same outlet.",
  );
  assert.deepEqual(
    {
      productCount: dashboardA.data.productCount,
      lowStockCount: dashboardA.data.lowStockCount,
      expiringSoonCount: dashboardA.data.expiringSoonCount,
      pendingApprovals: dashboardA.data.pendingApprovals,
    },
    {
      productCount: 2,
      lowStockCount: 1,
      expiringSoonCount: 3,
      pendingApprovals: 2,
    },
  );
  assert.deepEqual(
    {
      productCount: dashboardB.data.productCount,
      lowStockCount: dashboardB.data.lowStockCount,
      expiringSoonCount: dashboardB.data.expiringSoonCount,
      pendingApprovals: dashboardB.data.pendingApprovals,
    },
    {
      productCount: 2,
      lowStockCount: 0,
      expiringSoonCount: 0,
      pendingApprovals: 1,
    },
  );
  assert.equal(dashboardA.data.recentMovements.length, 6);
  assert.deepEqual(
    dashboardA.data.recentMovements.map(
      ({ reason }: { reason: string }) => reason,
    ),
    dashboardMovementReasons.slice(2).reverse(),
  );
  assert.ok(
    !dashboardA.data.recentMovements.some(
      ({ reason }: { reason: string }) => reason === dashboardActivityA,
    ),
  );
  assert.ok(
    !dashboardA.data.recentMovements.some(
      ({ reason }: { reason: string }) => reason === dashboardActivityB,
    ),
  );
  assert.ok(
    dashboardA.data.recentMovements.every(
      ({ productId }: { productId: number }) =>
        productId === productA.id || productId === fixtureProductIds[0],
    ),
  );
  assert.ok(
    dashboardB.data.recentMovements.some(
      ({ reason }: { reason: string }) => reason === dashboardActivityB,
    ),
  );
  assert.ok(
    !dashboardB.data.recentMovements.some(
      ({ reason }: { reason: string }) => reason === dashboardActivityA,
    ),
  );
  assert.ok(
    dashboardB.data.recentMovements.every(
      ({ productId }: { productId: number }) => productId === productB.id,
    ),
  );

  const customCategory = await api(secondOwnerId, "/product-categories", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { name: "Pastry" },
  });
  assert.equal(customCategory.response.status, 201, JSON.stringify(customCategory.data));
  const renamedCategory = await api(
    secondOwnerId,
    `/product-categories/${customCategory.data.id}`,
    {
      method: "PATCH",
      storeroomId: secondRoomId,
      body: { name: "Bakery" },
    },
  );
  assert.equal(renamedCategory.response.status, 200, JSON.stringify(renamedCategory.data));
  assert.equal(renamedCategory.data.key, customCategory.data.key);

  const sourceProduct = await createProduct(
    secondOwnerId,
    `${fixtureTag}-transfer-source`,
    secondRoomId,
  );
  const destinationProduct = await createProduct(
    secondOwnerId,
    `${fixtureTag}-transfer-destination`,
    secondOutletId,
  );
  const assignedCategory = await api(
    secondOwnerId,
    `/products/${sourceProduct.id}`,
    {
      method: "PATCH",
      storeroomId: secondRoomId,
      body: { category: customCategory.data.key },
    },
  );
  assert.equal(assignedCategory.response.status, 200, JSON.stringify(assignedCategory.data));
  const categoryInUse = await api(
    secondOwnerId,
    `/product-categories/${customCategory.data.id}`,
    { method: "DELETE", storeroomId: secondRoomId },
  );
  assert.equal(categoryInUse.response.status, 409, JSON.stringify(categoryInUse.data));
  const sourceCategoryList = await api(secondOwnerId, "/product-categories", {
    storeroomId: secondRoomId,
  });
  const destinationCategoryList = await api(secondOwnerId, "/product-categories", {
    storeroomId: secondOutletId,
  });
  assert.ok(sourceCategoryList.data.some(({ key }: { key: string }) => key === customCategory.data.key));
  assert.ok(!destinationCategoryList.data.some(({ key }: { key: string }) => key === customCategory.data.key));

  const sourceSections = await api(secondOwnerId, "/stock-sections", {
    storeroomId: secondRoomId,
  });
  const destinationSections = await api(secondOwnerId, "/stock-sections", {
    storeroomId: secondOutletId,
  });
  const sourceMain = sourceSections.data.find(({ isDefault }: { isDefault: boolean }) => isDefault);
  const destinationMain = destinationSections.data.find(({ isDefault }: { isDefault: boolean }) => isDefault);
  assert.ok(sourceMain && destinationMain);
  const chiller = await api(secondOwnerId, "/stock-sections", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { name: "Chiller" },
  });
  assert.equal(chiller.response.status, 201, JSON.stringify(chiller.data));

  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 1);
  const transferExpiryDate = expiry.toISOString().slice(0, 10);
  const openingStock = await api(secondOwnerId, "/inventory/adjustments", {
    method: "POST",
    storeroomId: secondRoomId,
    body: {
      productId: sourceProduct.id,
      sectionId: sourceMain.id,
      quantityDelta: 10,
      reason: `${fixtureTag}-transfer-opening-stock`,
      expiryDate: transferExpiryDate,
    },
  });
  assert.equal(openingStock.response.status, 201, JSON.stringify(openingStock.data));

  const intraOutletOptions = await api(
    secondOwnerId,
    `/stock-transfers/options?destinationOutletId=${secondRoomId}&productId=${sourceProduct.id}`,
    { storeroomId: secondRoomId },
  );
  assert.equal(intraOutletOptions.response.status, 200, JSON.stringify(intraOutletOptions.data));
  const sourceMainBalance = intraOutletOptions.data.sourceSections.find(
    ({ id }: { id: number }) => id === sourceMain.id,
  ).quantity as number;
  const chillerBalance = intraOutletOptions.data.destinationProducts[0].sections.find(
    ({ id }: { id: number }) => id === chiller.data.id,
  ).quantity as number;
  const intraPayload = {
    clientKey: crypto.randomUUID(),
    destinationOutletId: secondRoomId,
    productId: sourceProduct.id,
    destinationProductId: sourceProduct.id,
    sourceSectionId: sourceMain.id,
    destinationSectionId: chiller.data.id,
    quantity: 3.25,
    expectedSourceQuantity: sourceMainBalance,
    expectedDestinationQuantity: chillerBalance,
    note: "Move to the chiller",
  };
  const intraTransfer = await api(secondOwnerId, "/stock-transfers", {
    method: "POST",
    storeroomId: secondRoomId,
    body: intraPayload,
  });
  assert.equal(intraTransfer.response.status, 201, JSON.stringify(intraTransfer.data));
  fixtureTransferIds.push(intraTransfer.data.id);
  assert.equal(intraTransfer.data.sourceTotalBefore, 10);
  assert.equal(intraTransfer.data.sourceTotalAfter, 10);
  const listedTransfers = await api(secondOwnerId, "/stock-transfers", {
    storeroomId: secondRoomId,
  });
  assert.equal(listedTransfers.response.status, 200, JSON.stringify(listedTransfers.data));
  assert.ok(
    listedTransfers.data.some(
      ({
        id,
        sourceOutletId,
        destinationOutletId,
      }: {
        id: number;
        sourceOutletId: number;
        destinationOutletId: number;
      }) =>
        id === intraTransfer.data.id &&
        sourceOutletId === secondRoomId &&
        destinationOutletId === secondRoomId,
    ),
  );
  const intraRetry = await api(secondOwnerId, "/stock-transfers", {
    method: "POST",
    storeroomId: secondRoomId,
    body: intraPayload,
  });
  assert.equal(intraRetry.response.status, 201, JSON.stringify(intraRetry.data));
  assert.equal(intraRetry.data.id, intraTransfer.data.id, "Retrying a transfer must not create a second movement.");

  const crossOutletOptions = await api(
    secondOwnerId,
    `/stock-transfers/options?destinationOutletId=${secondOutletId}&productId=${sourceProduct.id}`,
    { storeroomId: secondRoomId },
  );
  assert.equal(crossOutletOptions.response.status, 200, JSON.stringify(crossOutletOptions.data));
  const compatibleProduct = crossOutletOptions.data.destinationProducts.find(
    ({ id }: { id: number }) => id === destinationProduct.id,
  );
  assert.ok(compatibleProduct, "Only a matching product in the destination outlet should be selectable.");
  const destinationDefaultBalance = compatibleProduct.sections.find(
    ({ id }: { id: number }) => id === destinationMain.id,
  ).quantity as number;
  const sourceChillerBalance = crossOutletOptions.data.sourceSections.find(
    ({ id }: { id: number }) => id === chiller.data.id,
  ).quantity as number;
  const crossPayload = {
    clientKey: crypto.randomUUID(),
    destinationOutletId: secondOutletId,
    productId: sourceProduct.id,
    destinationProductId: destinationProduct.id,
    sourceSectionId: chiller.data.id,
    destinationSectionId: destinationMain.id,
    quantity: 2.25,
    expectedSourceQuantity: sourceChillerBalance,
    expectedDestinationQuantity: destinationDefaultBalance,
  };
  const crossTransfer = await api(secondOwnerId, "/stock-transfers", {
    method: "POST",
    storeroomId: secondRoomId,
    body: crossPayload,
  });
  assert.equal(crossTransfer.response.status, 201, JSON.stringify(crossTransfer.data));
  fixtureTransferIds.push(crossTransfer.data.id);
  assert.equal(crossTransfer.data.sourceTotalBefore, 10);
  assert.equal(crossTransfer.data.sourceTotalAfter, 7.75);
  assert.equal(crossTransfer.data.destinationTotalBefore, 0);
  assert.equal(crossTransfer.data.destinationTotalAfter, 2.25);

  const staleTransfer = await api(secondOwnerId, "/stock-transfers", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { ...crossPayload, clientKey: crypto.randomUUID() },
  });
  assert.equal(staleTransfer.response.status, 409, JSON.stringify(staleTransfer.data));
  const staffTransfer = await api(secondManagerInviteeId, "/stock-transfers", {
    method: "POST",
    storeroomId: secondRoomId,
    body: {},
  });
  assert.equal(staffTransfer.response.status, 403, JSON.stringify(staffTransfer.data));
  const crossWorkspaceOptions = await api(
    secondOwnerId,
    `/stock-transfers/options?destinationOutletId=${legacyRoomId}&productId=${sourceProduct.id}`,
    { storeroomId: secondRoomId },
  );
  assert.equal(crossWorkspaceOptions.response.status, 404);

  const sourceBatches = await api(secondOwnerId, `/inventory/batches?productId=${sourceProduct.id}`, {
    storeroomId: secondRoomId,
  });
  const destinationBatches = await api(secondOwnerId, `/inventory/batches?productId=${destinationProduct.id}`, {
    storeroomId: secondOutletId,
  });
  assert.equal(sourceBatches.response.status, 200, JSON.stringify(sourceBatches.data));
  assert.equal(destinationBatches.response.status, 200, JSON.stringify(destinationBatches.data));
  assert.equal(sourceBatches.data.reduce((sum: number, batch: { quantity: number }) => sum + batch.quantity, 0), 7.75);
  assert.equal(destinationBatches.data.reduce((sum: number, batch: { quantity: number }) => sum + batch.quantity, 0), 2.25);
  assert.equal(destinationBatches.data[0].expiryDate.slice(0, 10), transferExpiryDate);
  assert.equal(destinationBatches.data[0].sectionName, destinationMain.name);

  const sourceMovements = await api(
    secondOwnerId,
    `/inventory/movements?productId=${sourceProduct.id}`,
    { storeroomId: secondRoomId },
  );
  const destinationMovements = await api(
    secondOwnerId,
    `/inventory/movements?productId=${destinationProduct.id}`,
    { storeroomId: secondOutletId },
  );
  assert.ok(sourceMovements.data.some(
    ({ type, otherOutletName, transferReference }: { type: string; otherOutletName?: string; transferReference?: string }) =>
      type === "transfer_out" && otherOutletName === "Airport Annex" && transferReference === crossTransfer.data.reference,
  ));
  assert.ok(destinationMovements.data.some(
    ({ type, otherOutletName, transferReference }: { type: string; otherOutletName?: string; transferReference?: string }) =>
      type === "transfer_in" && otherOutletName === "Downtown Outlet" && transferReference === crossTransfer.data.reference,
  ));
  const sourceTransferOut = sourceMovements.data.find(
    ({ type }: { type: string }) => type === "transfer_out",
  );
  assert.ok(sourceTransferOut, "source outlet should retain its transfer-out movement");
  const transferStartedAt = new Date(sourceTransferOut.occurredAt).toISOString();
  const transferEndsAt = new Date(Date.parse(transferStartedAt) + 1).toISOString();
  const filteredMovements = await api(
    secondOwnerId,
    `/inventory/movements?productId=${sourceProduct.id}&type=transfer_out&dateFrom=${encodeURIComponent(transferStartedAt)}&dateTo=${encodeURIComponent(transferEndsAt)}${sourceTransferOut.sectionName ? `&sectionName=${encodeURIComponent(sourceTransferOut.sectionName)}` : ""}`,
    { storeroomId: secondRoomId },
  );
  assert.equal(filteredMovements.response.status, 200, JSON.stringify(filteredMovements.data));
  assert.ok(filteredMovements.data.length > 0);
  assert.ok(filteredMovements.data.every(({ type }: { type: string }) => type === "transfer_out"));
  assert.ok(filteredMovements.data.some(
    ({ sectionName, otherOutletName }: { sectionName?: string; otherOutletName?: string }) =>
      sectionName === sourceTransferOut.sectionName && otherOutletName === "Airport Annex",
  ), "filtered history should retain the recorded section and outlet labels");

  const emptyCountSection = await api(secondOwnerId, "/stock-sections", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { name: `${fixtureTag} Count Area` },
  });
  assert.equal(emptyCountSection.response.status, 201, JSON.stringify(emptyCountSection.data));
  const sectionCount = await api(secondOwnerId, "/stock-counts", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { scope: "product", productId: sourceProduct.id },
  });
  assert.equal(sectionCount.response.status, 201, JSON.stringify(sectionCount.data));
  fixtureCountIds.push(sectionCount.data.id);
  assert.equal(sectionCount.data.lines.length, 3, "The count should have a separate line for every product and storage area.");
  assert.ok(
    sectionCount.data.lines.some(
      ({ sectionName, expectedQuantity }: { sectionName: string; expectedQuantity: number }) =>
        sectionName === emptyCountSection.data.name && expectedQuantity === 0,
    ),
    "Empty storage areas must still be countable so misplaced stock can be recorded.",
  );
  const cannotDeleteCountSection = await api(
    secondOwnerId,
    `/stock-sections/${emptyCountSection.data.id}`,
    { method: "DELETE", storeroomId: secondRoomId },
  );
  assert.equal(cannotDeleteCountSection.response.status, 409);

  const stockMovedDuringCount = await api(
    secondOwnerId,
    "/inventory/adjustments",
    {
      method: "POST",
      storeroomId: secondRoomId,
      body: {
        productId: sourceProduct.id,
        sectionId: sourceMain.id,
        quantityDelta: 2,
        reason: `${fixtureTag}-movement-during-count`,
      },
    },
  );
  assert.equal(stockMovedDuringCount.response.status, 201, JSON.stringify(stockMovedDuringCount.data));
  const staleSectionCountSubmit = await api(
    secondOwnerId,
    `/stock-counts/${sectionCount.data.id}/submit`,
    {
      method: "POST",
      storeroomId: secondRoomId,
      body: {
        lines: sectionCount.data.lines.map(
          ({
            productId,
            sectionId,
            expectedQuantity,
          }: {
            productId: number;
            sectionId: number;
            expectedQuantity: number;
          }) => ({
            productId,
            sectionId,
            countedQuantity: expectedQuantity + (sectionId === sourceMain.id ? 2.5 : 0),
          }),
        ),
        acknowledgedMovementIds: [],
      },
    },
  );
  assert.equal(staleSectionCountSubmit.response.status, 409, JSON.stringify(staleSectionCountSubmit.data));
  const refreshedSectionCount = await api(
    secondOwnerId,
    `/stock-counts/${sectionCount.data.id}`,
    { storeroomId: secondRoomId },
  );
  assert.ok(
    refreshedSectionCount.data.movements.some(
      ({
        productId,
        sectionName,
        quantityDelta,
      }: {
        productId: number;
        sectionName: string;
        quantityDelta: number;
      }) =>
        productId === sourceProduct.id &&
        sectionName === sourceMain.name &&
        quantityDelta === 2,
    ),
    "An open count should show a later movement with its product, area, and quantity.",
  );
  const stockMovedAfterCountRefresh = await api(
    secondOwnerId,
    "/inventory/adjustments",
    {
      method: "POST",
      storeroomId: secondRoomId,
      body: {
        productId: sourceProduct.id,
        sectionId: sourceMain.id,
        quantityDelta: 1,
        reason: `${fixtureTag}-movement-after-count-refresh`,
      },
    },
  );
  assert.equal(stockMovedAfterCountRefresh.response.status, 201, JSON.stringify(stockMovedAfterCountRefresh.data));
  const stockBeforeRejectedRetry = await db
    .select({
      quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
    })
    .from(stockBatchesTable)
    .where(eq(stockBatchesTable.productId, sourceProduct.id));
  const movementsBeforeRejectedRetry = await api(
    secondOwnerId,
    `/inventory/movements?productId=${sourceProduct.id}`,
    { storeroomId: secondRoomId },
  );
  const staleRefreshedSectionCountSubmit = await api(
    secondOwnerId,
    `/stock-counts/${sectionCount.data.id}/submit`,
    {
      method: "POST",
      storeroomId: secondRoomId,
      body: {
        lines: sectionCount.data.lines.map(
          ({
            productId,
            sectionId,
            expectedQuantity,
          }: {
            productId: number;
            sectionId: number;
            expectedQuantity: number;
          }) => ({
            productId,
            sectionId,
            countedQuantity: expectedQuantity + (sectionId === sourceMain.id ? 3.5 : 0),
          }),
        ),
        acknowledgedMovementIds: refreshedSectionCount.data.movements.map(
          ({ id }: { id: number }) => id,
        ),
      },
    },
  );
  assert.equal(staleRefreshedSectionCountSubmit.response.status, 409, JSON.stringify(staleRefreshedSectionCountSubmit.data));
  const stockAfterRejectedRetry = await db
    .select({
      quantity: sql<number>`coalesce(sum(${stockBatchesTable.quantity}), 0)::float`,
    })
    .from(stockBatchesTable)
    .where(eq(stockBatchesTable.productId, sourceProduct.id));
  assert.equal(
    stockAfterRejectedRetry[0]?.quantity,
    stockBeforeRejectedRetry[0]?.quantity,
    "A stale confirmation must not change stock.",
  );
  const countAfterRejectedRetry = await api(
    secondOwnerId,
    `/stock-counts/${sectionCount.data.id}`,
    { storeroomId: secondRoomId },
  );
  assert.equal(countAfterRejectedRetry.data.status, "in_progress");
  assert.ok(
    countAfterRejectedRetry.data.lines.every(
      ({ countedQuantity }: { countedQuantity: number | null }) => countedQuantity === null,
    ),
    "A stale confirmation must not save counted quantities.",
  );
  const movementsAfterRejectedRetry = await api(
    secondOwnerId,
    `/inventory/movements?productId=${sourceProduct.id}`,
    { storeroomId: secondRoomId },
  );
  assert.deepEqual(
    movementsAfterRejectedRetry.data.map(({ id }: { id: number }) => id).sort((a: number, b: number) => a - b),
    movementsBeforeRejectedRetry.data.map(({ id }: { id: number }) => id).sort((a: number, b: number) => a - b),
    "A stale confirmation must preserve the movement audit trail without writing a count movement.",
  );
  const refreshedAfterLateMovementCount = await api(
    secondOwnerId,
    `/stock-counts/${sectionCount.data.id}`,
    { storeroomId: secondRoomId },
  );
  assert.ok(
    refreshedAfterLateMovementCount.data.movements.some(
      ({
        productId,
        sectionName,
        quantityDelta,
      }: {
        productId: number;
        sectionName: string;
        quantityDelta: number;
      }) =>
        productId === sourceProduct.id &&
        sectionName === sourceMain.name &&
        quantityDelta === 1,
    ),
    "Refreshing after rejection should expose the movement that arrived after the previous refresh.",
  );
  const sectionCountSubmission = await api(
    secondOwnerId,
    `/stock-counts/${sectionCount.data.id}/submit`,
    {
      method: "POST",
      storeroomId: secondRoomId,
      body: {
        lines: sectionCount.data.lines.map(
          ({
            productId,
            sectionId,
            expectedQuantity,
          }: {
            productId: number;
            sectionId: number;
            expectedQuantity: number;
          }) => ({
            productId,
            sectionId,
            countedQuantity: expectedQuantity + (sectionId === sourceMain.id ? 3.5 : 0),
          }),
        ),
        acknowledgedMovementIds: refreshedAfterLateMovementCount.data.movements.map(
          ({ id }: { id: number }) => id,
        ),
      },
    },
  );
  assert.equal(sectionCountSubmission.response.status, 200, JSON.stringify(sectionCountSubmission.data));
  assert.equal(sectionCountSubmission.data.status, "completed");
  const sectionCountMovements = await api(
    secondOwnerId,
    `/inventory/movements?productId=${sourceProduct.id}`,
    { storeroomId: secondRoomId },
  );
  assert.ok(
    sectionCountMovements.data.some(
      ({
        type,
        sectionName,
        quantityDelta,
      }: {
        type: string;
        sectionName: string;
        quantityDelta: number;
      }) => type === "count" && sectionName === sourceMain.name && quantityDelta === 0.5,
    ),
    "A count variance must adjust stock and write its movement against the correct area.",
  );
  assert.ok(
    sectionCountMovements.data.some(
      ({
        type,
        sectionName,
        quantityDelta,
      }: {
        type: string;
        sectionName: string;
        quantityDelta: number;
      }) => type === "adjustment" && sectionName === sourceMain.name && quantityDelta === 2,
    ),
    "The original movement should remain in the stock audit trail after the count is completed.",
  );
  assert.ok(
    sectionCountMovements.data.some(
      ({
        type,
        sectionName,
        quantityDelta,
      }: {
        type: string;
        sectionName: string;
        quantityDelta: number;
      }) => type === "adjustment" && sectionName === sourceMain.name && quantityDelta === 1,
    ),
    "The movement added after refresh should remain in the stock audit trail after the count is completed.",
  );
  const deleteCountSectionAfterCompletion = await api(
    secondOwnerId,
    `/stock-sections/${emptyCountSection.data.id}`,
    { method: "DELETE", storeroomId: secondRoomId },
  );
  assert.equal(deleteCountSectionAfterCompletion.response.status, 204);
  const completedSectionCount = await api(
    secondOwnerId,
    `/stock-counts/${sectionCount.data.id}`,
    { storeroomId: secondRoomId },
  );
  assert.ok(
    completedSectionCount.data.lines.some(
      ({ sectionId, sectionName }: { sectionId: number | null; sectionName: string | null }) =>
        sectionId === null && sectionName === emptyCountSection.data.name,
    ),
    "Completed counts should retain the storage-area name as historical context.",
  );

  const freezerSectionCount = await api(secondOwnerId, "/stock-counts", {
    method: "POST",
    storeroomId: secondRoomId,
    body: { scope: "section", sectionId: chiller.data.id },
  });
  assert.equal(freezerSectionCount.response.status, 201, JSON.stringify(freezerSectionCount.data));
  fixtureCountIds.push(freezerSectionCount.data.id);
  const movementInAnotherSection = await api(secondOwnerId, "/inventory/adjustments", {
    method: "POST",
    storeroomId: secondRoomId,
    body: {
      productId: sourceProduct.id,
      sectionId: sourceMain.id,
      quantityDelta: 1,
      reason: `${fixtureTag}-parallel-section-count`,
    },
  });
  assert.equal(movementInAnotherSection.response.status, 201, JSON.stringify(movementInAnotherSection.data));
  const refreshedFreezerCount = await api(
    secondOwnerId,
    `/stock-counts/${freezerSectionCount.data.id}`,
    { storeroomId: secondRoomId },
  );
  assert.equal(
    refreshedFreezerCount.data.movements.length,
    0,
    "A count for one storage section must not show a movement recorded in another section.",
  );
  const completedFreezerCount = await api(
    secondOwnerId,
    `/stock-counts/${freezerSectionCount.data.id}/submit`,
    {
      method: "POST",
      storeroomId: secondRoomId,
      body: {
        lines: freezerSectionCount.data.lines.map(
          ({
            productId,
            sectionId,
            expectedQuantity,
          }: {
            productId: number;
            sectionId: number;
            expectedQuantity: number;
          }) => ({ productId, sectionId, countedQuantity: expectedQuantity }),
        ),
        acknowledgedMovementIds: [],
      },
    },
  );
  assert.equal(
    completedFreezerCount.response.status,
    200,
    JSON.stringify(completedFreezerCount.data),
  );

  const sectionWithStock = await api(
    secondOwnerId,
    `/stock-sections/${chiller.data.id}`,
    { method: "DELETE", storeroomId: secondRoomId },
  );
  assert.equal(sectionWithStock.response.status, 409);

  const resetProductCategory = await api(secondOwnerId, `/products/${sourceProduct.id}`, {
    method: "PATCH",
    storeroomId: secondRoomId,
    body: { category: "food" },
  });
  assert.equal(resetProductCategory.response.status, 200, JSON.stringify(resetProductCategory.data));
  const deleteUnusedCategory = await api(
    secondOwnerId,
    `/product-categories/${customCategory.data.id}`,
    { method: "DELETE", storeroomId: secondRoomId },
  );
  assert.equal(deleteUnusedCategory.response.status, 204);

  const auditSiblingOutlet = await api(legacyOwnerId, "/outlets", {
    method: "POST",
    body: { name: `${fixtureTag} Access Audit Outlet` },
  });
  assert.equal(auditSiblingOutlet.response.status, 201, JSON.stringify(auditSiblingOutlet.data));
  const auditSiblingOutletId = auditSiblingOutlet.data.id as number;
  fixtureStoreroomIds.push(auditSiblingOutletId);
  const siblingStaffMembership = await api(legacyOwnerId, "/users", {
    method: "POST",
    storeroomId: auditSiblingOutletId,
    body: {
      email: `${legacyStaffId}@example.invalid`,
      role: "staff",
      access: staffAccess,
    },
  });
  assert.equal(siblingStaffMembership.response.status, 201, JSON.stringify(siblingStaffMembership.data));
  const siblingAccess = { ...staffAccess, products: "edit" };
  const siblingAccessUpdate = await api(
    legacyOwnerId,
    `/users/${legacyStaffId}/access`,
    {
      method: "PATCH",
      storeroomId: auditSiblingOutletId,
      body: { access: siblingAccess },
    },
  );
  assert.equal(siblingAccessUpdate.response.status, 200, JSON.stringify(siblingAccessUpdate.data));
  const siblingAccessEvents = await api(
    legacyOwnerId,
    "/users/security-events",
    { storeroomId: auditSiblingOutletId },
  );
  assert.ok(
    siblingAccessEvents.data.some(
      ({
        eventType,
        targetUserId,
        storeroomId,
        changedSections,
      }: {
        eventType: string;
        targetUserId: string;
        storeroomId: number;
        changedSections: { section: string; previousAccess: string; newAccess: string }[];
      }) =>
        eventType === "staff_access_updated" &&
        targetUserId === legacyStaffId &&
        storeroomId === auditSiblingOutletId &&
        changedSections.some(
          (change) =>
            change.section === "products" &&
            change.previousAccess === "none" &&
            change.newAccess === "edit",
        ),
    ),
  );
  const originalOutletEventsAfterSiblingUpdate = await api(
    legacyOwnerId,
    "/users/security-events",
    { storeroomId: legacyRoomId },
  );
  assert.equal(
    originalOutletEventsAfterSiblingUpdate.data.filter(
      ({ eventType, targetUserId }: { eventType: string; targetUserId: string }) =>
        eventType === "staff_access_updated" && targetUserId === legacyStaffId,
    ).length,
    1,
    "A sibling outlet's permission change must not appear in the original outlet's audit history.",
  );

  const emptyStaffAccess = {
    dashboard: "none",
    receiving: "none",
    deliveryRecords: "none",
    products: "none",
    suppliers: "none",
    stockTransfers: "none",
    purchaseOrders: "none",
    approvals: "none",
    activity: "none",
    stockCount: "none",
  };
  const setStaffAccess = async (
    storeroomId: number,
    access: Record<string, string>,
  ) => {
    const updated = await api(
      legacyOwnerId,
      `/users/${legacyStaffId}/access`,
      { method: "PATCH", storeroomId, body: { access } },
    );
    assert.equal(updated.response.status, 200, JSON.stringify(updated.data));
  };
  const productBody = (name: string) => ({
    name,
    category: "food",
    unit: "case",
    bundleSize: 1,
    minStock: 0,
  });

  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal((await api(legacyStaffId, "/products")).response.status, 403);
  assert.equal(
    (await api(legacyStaffId, "/products", {
      method: "POST",
      body: productBody(`${fixtureTag}-blocked-product`),
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, { ...emptyStaffAccess, products: "view" });
  assert.equal((await api(legacyStaffId, "/products")).response.status, 200);
  assert.equal(
    (await api(legacyStaffId, `/products/${productA.id}`, {
      method: "PATCH",
      body: { minStock: 18 },
    })).response.status,
    403,
  );
  assert.equal(
    (await api(legacyStaffId, "/products", {
      method: "POST",
      body: productBody(`${fixtureTag}-view-only-product`),
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, { ...emptyStaffAccess, products: "edit" });
  const staffProduct = await api(legacyStaffId, "/products", {
    method: "POST",
    body: productBody(`${fixtureTag}-staff-added-product`),
  });
  assert.equal(staffProduct.response.status, 201, JSON.stringify(staffProduct.data));
  fixtureProductIds.push(staffProduct.data.id);
  assert.equal(
    (await api(legacyStaffId, `/products/${productA.id}`, {
      method: "PATCH",
      body: { minStock: 18 },
    })).response.status,
    200,
  );
  const removableSection = await api(legacyOwnerId, "/stock-sections", {
    method: "POST",
    storeroomId: legacyRoomId,
    body: { name: `${fixtureTag}-staff-delete-protection` },
  });
  assert.equal(removableSection.response.status, 201, JSON.stringify(removableSection.data));
  assert.equal(
    (await api(legacyStaffId, `/stock-sections/${removableSection.data.id}`, {
      method: "DELETE",
    })).response.status,
    403,
    "Even edit access must not allow staff to delete records.",
  );
  const stillPresentSection = await api(legacyOwnerId, "/stock-sections", {
    storeroomId: legacyRoomId,
  });
  assert.ok(stillPresentSection.data.some(({ id }: { id: number }) => id === removableSection.data.id));

  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal((await api(legacyStaffId, "/stock-counts")).response.status, 403);
  assert.equal(
    (await api(legacyStaffId, "/stock-counts", {
      method: "POST",
      body: { scope: "all" },
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, { ...emptyStaffAccess, stockCount: "view" });
  assert.equal((await api(legacyStaffId, "/stock-counts")).response.status, 200);
  assert.equal(
    (await api(legacyStaffId, "/stock-counts", {
      method: "POST",
      body: { scope: "all" },
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, { ...emptyStaffAccess, stockCount: "edit" });
  const staffCount = await api(legacyStaffId, "/stock-counts", {
    method: "POST",
    body: { scope: "all" },
  });
  assert.equal(staffCount.response.status, 201, JSON.stringify(staffCount.data));
  fixtureCountIds.push(staffCount.data.id);
  assert.equal(
    (await api(legacyStaffId, `/stock-counts/${staffCount.data.id}`, {
      method: "DELETE",
    })).response.status,
    403,
  );

  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal((await api(legacyStaffId, "/deliveries")).response.status, 403);
  assert.equal(
    (await api(legacyStaffId, "/deliveries", {
      method: "POST",
      body: { lines: [{ productId: productA.id, quantity: 1 }] },
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    receiving: "view",
    deliveryRecords: "view",
  });
  assert.equal((await api(legacyStaffId, "/deliveries")).response.status, 200);
  assert.equal(
    (await api(legacyStaffId, "/deliveries", {
      method: "POST",
      body: { lines: [{ productId: productA.id, quantity: 1 }] },
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    receiving: "edit",
    deliveryRecords: "view",
  });
  const staffDelivery = await api(legacyStaffId, "/deliveries", {
    method: "POST",
    body: { lines: [{ productId: productA.id, quantity: 1 }] },
  });
  if (Number.isSafeInteger(staffDelivery.data?.id)) {
    fixtureDeliveryIds.push(staffDelivery.data.id);
  }
  assert.equal(staffDelivery.response.status, 201, JSON.stringify(staffDelivery.data));

  const receiptAccessOrder = await api(legacyOwnerId, "/purchase-orders", {
    storeroomId: legacyRoomId,
    method: "POST",
    body: { lines: [{ productId: productA.id, quantity: 1 }] },
  });
  assert.equal(receiptAccessOrder.response.status, 201, JSON.stringify(receiptAccessOrder.data));
  fixtureOrderIds.push(receiptAccessOrder.data.id);
  await db
    .update(purchaseOrdersTable)
    .set({ status: "issued" })
    .where(eq(purchaseOrdersTable.id, receiptAccessOrder.data.id));
  const receiptBody = {
    lines: [{ productId: productA.id, receivedQuantity: 0.25 }],
  };
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    purchaseOrders: "edit",
  });
  assert.equal(
    (await api(
      legacyStaffId,
      `/purchase-orders/${receiptAccessOrder.data.id}/receipts`,
      { method: "POST", body: receiptBody },
    )).response.status,
    403,
    "Purchase-order edit access alone must not authorize a stock receipt.",
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    receiving: "view",
  });
  assert.equal(
    (await api(
      legacyStaffId,
      `/purchase-orders/${receiptAccessOrder.data.id}/receipts`,
      { method: "POST", body: receiptBody },
    )).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    receiving: "edit",
  });
  const staffReceipt = await api(
    legacyStaffId,
    `/purchase-orders/${receiptAccessOrder.data.id}/receipts`,
    { method: "POST", body: receiptBody },
  );
  assert.equal(staffReceipt.response.status, 200, JSON.stringify(staffReceipt.data));

  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal((await api(legacyStaffId, "/purchase-orders")).response.status, 403);
  assert.equal(
    (await api(legacyStaffId, "/purchase-orders/history/export")).response.status,
    403,
    "Purchase-order history export requires outlet purchase-order access.",
  );
  assert.equal(
    (await api(legacyStaffId, "/purchase-orders", {
      method: "POST",
      body: { lines: [{ productId: productA.id, quantity: 1 }] },
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    purchaseOrders: "view",
  });
  assert.equal((await api(legacyStaffId, "/purchase-orders")).response.status, 200);
  assert.equal(
    (await api(legacyStaffId, "/purchase-orders/history/export")).response.status,
    200,
    "Staff with view access can export their outlet's purchase-order history.",
  );
  assert.equal(
    (await api(legacyStaffId, "/purchase-orders", {
      method: "POST",
      body: { lines: [{ productId: productA.id, quantity: 1 }] },
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    purchaseOrders: "edit",
  });
  const staffOrder = await api(legacyStaffId, "/purchase-orders", {
    method: "POST",
    body: { lines: [{ productId: productA.id, quantity: 1 }] },
  });
  assert.equal(staffOrder.response.status, 201, JSON.stringify(staffOrder.data));
  fixtureOrderIds.push(staffOrder.data.id);
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    purchaseOrders: "view",
  });
  const staffOrderHistory = await api(
    legacyStaffId,
    `/purchase-orders/${staffOrder.data.id}/history`,
  );
  assert.equal(staffOrderHistory.response.status, 200);
  assert.equal(staffOrderHistory.data[0]?.actor, legacyStaffId);
  assert.equal(staffOrderHistory.data[0]?.action, "Purchase-order request submitted");
  assert.equal(
    (await api(legacyStaffId, `/purchase-orders/${staffOrder.data.id}`, {
      method: "DELETE",
    })).response.status,
    403,
  );

  const approvalSupplier = await api(legacyOwnerId, "/suppliers", {
    storeroomId: legacyRoomId,
    method: "POST",
    body: { name: `${fixtureTag}-approval-supplier` },
  });
  assert.equal(approvalSupplier.response.status, 201, JSON.stringify(approvalSupplier.data));
  const pendingApprovalOrder = await api(legacyOwnerId, "/purchase-orders", {
    storeroomId: legacyRoomId,
    method: "POST",
    body: {
      supplierId: approvalSupplier.data.id,
      note: "Original request note",
      lines: [{ productId: productA.id, quantity: 1 }],
    },
  });
  assert.equal(pendingApprovalOrder.response.status, 201, JSON.stringify(pendingApprovalOrder.data));
  fixtureOrderIds.push(pendingApprovalOrder.data.id);
  assert.equal(pendingApprovalOrder.data.status, "pending");
  const editedPendingOrder = await api(
    legacyOwnerId,
    `/purchase-orders/${pendingApprovalOrder.data.id}`,
    {
      storeroomId: legacyRoomId,
      method: "PATCH",
      body: {
        supplierId: approvalSupplier.data.id,
        expectedDeliveryDate: "2026-11-20",
        note: "Original request note",
        lines: [{ productId: productA.id, quantity: 2 }],
      },
    },
  );
  assert.equal(editedPendingOrder.response.status, 200, JSON.stringify(editedPendingOrder.data));
  assert.equal(editedPendingOrder.data.lines[0]?.quantity, 2);
  const approvalDecision = {
    decision: "approved",
    note: "Within the approved monthly budget.",
  };
  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal(
    (await api(legacyStaffId, `/purchase-orders/${pendingApprovalOrder.data.id}/decision`, {
      method: "POST",
      body: approvalDecision,
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    approvals: "view",
  });
  assert.equal(
    (await api(legacyStaffId, `/purchase-orders/${pendingApprovalOrder.data.id}/decision`, {
      method: "POST",
      body: approvalDecision,
    })).response.status,
    403,
  );
  const approvalsVisiblePurchaseOrders = await api(legacyStaffId, "/purchase-orders");
  assert.equal(approvalsVisiblePurchaseOrders.response.status, 200);
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    approvals: "edit",
  });
  const staffApprovalAttempt = await api(
    legacyStaffId,
    `/purchase-orders/${pendingApprovalOrder.data.id}/decision`,
    { method: "POST", body: approvalDecision },
  );
  assert.equal(
    staffApprovalAttempt.response.status,
    403,
    "A staff permission override must not allow purchase-order approval.",
  );
  const approvedByOwner = await api(
    legacyOwnerId,
    `/purchase-orders/${pendingApprovalOrder.data.id}/decision`,
    { method: "POST", storeroomId: legacyRoomId, body: approvalDecision },
  );
  assert.equal(approvedByOwner.response.status, 200, JSON.stringify(approvedByOwner.data));
  assert.equal(approvedByOwner.data.note, "Original request note");
  const approvedOrderHistory = await api(
    legacyOwnerId,
    `/purchase-orders/${pendingApprovalOrder.data.id}/history`,
    { storeroomId: legacyRoomId },
  );
  assert.equal(approvedOrderHistory.response.status, 200);
  assert.equal(approvedOrderHistory.data.at(-1)?.note, approvalDecision.note);
  const approvedActivity = await api(legacyOwnerId, "/activity", {
    storeroomId: legacyRoomId,
  });
  assert.equal(approvedActivity.response.status, 200);
  const approvedActivityEntry = approvedActivity.data.find(
    (entry: { action: string; target: string | null }) =>
      entry.action === "Order approved" &&
      entry.target === approvedByOwner.data.orderNumber,
  );
  assert.ok(approvedActivityEntry);
  assert.ok(approvedActivityEntry.detail.includes(approvalDecision.note));
  const approvedActivityFromOtherOutlet = await api(secondOwnerId, "/activity", {
    storeroomId: secondRoomId,
  });
  assert.equal(approvedActivityFromOtherOutlet.response.status, 200);
  assert.ok(
    !approvedActivityFromOtherOutlet.data.some(
      (entry: { detail: string }) => entry.detail.includes(approvalDecision.note),
    ),
    "Purchase-order decision reasons must not leak into another outlet's Activity.",
  );
  const orderHistoryExport = await api(
    legacyOwnerId,
    "/purchase-orders/history/export",
    { storeroomId: legacyRoomId },
  );
  assert.equal(orderHistoryExport.response.status, 200);
  assert.ok(
    orderHistoryExport.data.some(
      (event: { orderId: number; note: string | null }) =>
        event.orderId === pendingApprovalOrder.data.id &&
        event.note === approvalDecision.note,
    ),
  );
  const orderHistoryFromOtherOutlet = await api(
    secondOwnerId,
    `/purchase-orders/${pendingApprovalOrder.data.id}/history`,
    { storeroomId: secondRoomId },
  );
  assert.equal(orderHistoryFromOtherOutlet.response.status, 404);
  assert.doesNotMatch(
    JSON.stringify(orderHistoryFromOtherOutlet.data),
    /Within the approved monthly budget/,
  );

  const approvalWithoutReasonOrder = await api(legacyOwnerId, "/purchase-orders", {
    storeroomId: legacyRoomId,
    method: "POST",
    body: {
      supplierId: approvalSupplier.data.id,
      lines: [{ productId: productA.id, quantity: 1 }],
    },
  });
  assert.equal(approvalWithoutReasonOrder.response.status, 201);
  fixtureOrderIds.push(approvalWithoutReasonOrder.data.id);
  await db
    .update(purchaseOrdersTable)
    .set({ status: "pending" })
    .where(eq(purchaseOrdersTable.id, approvalWithoutReasonOrder.data.id));
  const approvedWithoutReason = await api(
    legacyOwnerId,
    `/purchase-orders/${approvalWithoutReasonOrder.data.id}/decision`,
    {
      storeroomId: legacyRoomId,
      method: "POST",
      body: { decision: "approved" },
    },
  );
  assert.equal(approvedWithoutReason.response.status, 200);

  const pendingRejectionOrder = await api(legacyOwnerId, "/purchase-orders", {
    storeroomId: legacyRoomId,
    method: "POST",
    body: {
      note: "Original rejection request note",
      lines: [{ productId: productA.id, quantity: 1 }],
    },
  });
  assert.equal(pendingRejectionOrder.response.status, 201);
  fixtureOrderIds.push(pendingRejectionOrder.data.id);
  await db
    .update(purchaseOrdersTable)
    .set({ status: "pending" })
    .where(eq(purchaseOrdersTable.id, pendingRejectionOrder.data.id));
  const rejectionReason = "Supplier cannot deliver before the cutoff.";
  const rejectedOrder = await api(
    legacyOwnerId,
    `/purchase-orders/${pendingRejectionOrder.data.id}/decision`,
    {
      storeroomId: legacyRoomId,
      method: "POST",
      body: { decision: "rejected", note: rejectionReason },
    },
  );
  assert.equal(rejectedOrder.response.status, 200, JSON.stringify(rejectedOrder.data));
  assert.equal(rejectedOrder.data.note, "Original rejection request note");
  const rejectedOrderHistory = await api(
    legacyOwnerId,
    `/purchase-orders/${pendingRejectionOrder.data.id}/history`,
    { storeroomId: legacyRoomId },
  );
  assert.equal(rejectedOrderHistory.response.status, 200);
  assert.equal(rejectedOrderHistory.data.at(-1)?.note, rejectionReason);
  const rejectedActivity = await api(legacyOwnerId, "/activity", {
    storeroomId: legacyRoomId,
  });
  assert.equal(rejectedActivity.response.status, 200);
  const rejectedActivityEntry = rejectedActivity.data.find(
    (entry: { action: string; target: string | null }) =>
      entry.action === "Order rejected" &&
      entry.target === pendingRejectionOrder.data.orderNumber,
  );
  assert.ok(rejectedActivityEntry);
  assert.ok(rejectedActivityEntry.detail.includes(rejectionReason));

  const rejectionWithoutReasonOrder = await api(legacyOwnerId, "/purchase-orders", {
    storeroomId: legacyRoomId,
    method: "POST",
    body: { lines: [{ productId: productA.id, quantity: 1 }] },
  });
  assert.equal(rejectionWithoutReasonOrder.response.status, 201);
  fixtureOrderIds.push(rejectionWithoutReasonOrder.data.id);
  await db
    .update(purchaseOrdersTable)
    .set({ status: "pending" })
    .where(eq(purchaseOrdersTable.id, rejectionWithoutReasonOrder.data.id));
  const rejectedWithoutReason = await api(
    legacyOwnerId,
    `/purchase-orders/${rejectionWithoutReasonOrder.data.id}/decision`,
    {
      storeroomId: legacyRoomId,
      method: "POST",
      body: { decision: "rejected" },
    },
  );
  assert.equal(rejectedWithoutReason.response.status, 400);
  assert.match(rejectedWithoutReason.data.error, /reason is required/i);
  const rejectedWithWhitespace = await api(
    legacyOwnerId,
    `/purchase-orders/${rejectionWithoutReasonOrder.data.id}/decision`,
    {
      storeroomId: legacyRoomId,
      method: "POST",
      body: { decision: "rejected", note: " \t\n " },
    },
  );
  assert.equal(rejectedWithWhitespace.response.status, 400);
  assert.equal(
    (await api(
      legacyOwnerId,
      `/purchase-orders/${rejectionWithoutReasonOrder.data.id}/decision`,
      {
        storeroomId: legacyRoomId,
        method: "POST",
        body: { decision: "rejected", note: "Supplier cannot meet the required date." },
      },
    )).response.status,
    200,
    "The request remains reviewable after rejection attempts without a reason.",
  );

  const setProductTemperatureRule = await api(
    legacyOwnerId,
    `/products/${productA.id}`,
    {
      method: "PATCH",
      storeroomId: legacyRoomId,
      body: { tempMinC: 2, tempMaxC: 8 },
    },
  );
  assert.equal(setProductTemperatureRule.response.status, 200, JSON.stringify(setProductTemperatureRule.data));
  const heldDelivery = await api(legacyOwnerId, "/deliveries", {
    storeroomId: legacyRoomId,
    method: "POST",
    body: {
      lines: [{ productId: productA.id, quantity: 0.1, tempC: 10 }],
    },
  });
  if (Number.isSafeInteger(heldDelivery.data?.id)) {
    fixtureDeliveryIds.push(heldDelivery.data.id);
  }
  assert.equal(heldDelivery.response.status, 201, JSON.stringify(heldDelivery.data));
  assert.equal(heldDelivery.data.status, "pending_approval");
  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal(
    (await api(
      legacyStaffId,
      `/deliveries/${heldDelivery.data.id}/decision`,
      { method: "POST", body: { decision: "accepted" } },
    )).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    approvals: "view",
  });
  assert.equal(
    (await api(
      legacyStaffId,
      `/deliveries/${heldDelivery.data.id}/decision`,
      { method: "POST", body: { decision: "accepted" } },
    )).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    approvals: "edit",
  });
  const approvedByStaffDelivery = await api(
    legacyStaffId,
    `/deliveries/${heldDelivery.data.id}/decision`,
    { method: "POST", body: { decision: "accepted" } },
  );
  assert.equal(
    approvedByStaffDelivery.response.status,
    200,
    JSON.stringify(approvedByStaffDelivery.data),
  );

  const transferDestinationProduct = await createProduct(
    legacyOwnerId,
    `${fixtureTag}-staff-transfer-destination`,
    auditSiblingOutletId,
  );
  const sourceTransferOptions = await api(
    legacyOwnerId,
    `/stock-transfers/options?destinationOutletId=${auditSiblingOutletId}&productId=${productA.id}`,
    { storeroomId: legacyRoomId },
  );
  assert.equal(sourceTransferOptions.response.status, 200, JSON.stringify(sourceTransferOptions.data));
  const sourceTransferSection = sourceTransferOptions.data.sourceSections.find(
    ({ quantity }: { quantity: number }) => quantity > 0,
  );
  const destinationTransferProduct = sourceTransferOptions.data.destinationProducts.find(
    ({ id }: { id: number }) => id === transferDestinationProduct.id,
  );
  assert.ok(sourceTransferSection);
  assert.ok(destinationTransferProduct);
  const destinationTransferSection = destinationTransferProduct.sections[0];
  const transferBody = {
    clientKey: crypto.randomUUID(),
    destinationOutletId: auditSiblingOutletId,
    productId: productA.id,
    destinationProductId: transferDestinationProduct.id,
    sourceSectionId: sourceTransferSection.id,
    destinationSectionId: destinationTransferSection.id,
    quantity: 0.01,
    expectedSourceQuantity: sourceTransferSection.quantity,
    expectedDestinationQuantity: destinationTransferSection.quantity,
  };
  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal((await api(legacyStaffId, "/stock-transfers")).response.status, 403);
  assert.equal(
    (await api(legacyStaffId, "/stock-transfers", {
      method: "POST",
      body: transferBody,
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    stockTransfers: "view",
  });
  assert.equal((await api(legacyStaffId, "/stock-transfers")).response.status, 200);
  assert.equal(
    (await api(legacyStaffId, "/stock-transfers", {
      method: "POST",
      body: transferBody,
    })).response.status,
    403,
  );
  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    stockTransfers: "edit",
  });
  await setStaffAccess(auditSiblingOutletId, {
    ...emptyStaffAccess,
    stockTransfers: "view",
  });
  assert.equal(
    (await api(
      legacyStaffId,
      `/stock-transfers/options?destinationOutletId=${auditSiblingOutletId}&productId=${productA.id}`,
    )).response.status,
    403,
    "Source edit access must not bypass the destination outlet's view-only transfer permission.",
  );
  assert.equal(
    (await api(legacyStaffId, "/stock-transfers", {
      method: "POST",
      body: transferBody,
    })).response.status,
    403,
  );
  await setStaffAccess(auditSiblingOutletId, {
    ...emptyStaffAccess,
    stockTransfers: "edit",
  });
  const transferOptionsAsStaff = await api(
    legacyStaffId,
    `/stock-transfers/options?destinationOutletId=${auditSiblingOutletId}&productId=${productA.id}`,
  );
  assert.equal(transferOptionsAsStaff.response.status, 200, JSON.stringify(transferOptionsAsStaff.data));
  const delegatedStaffTransfer = await api(legacyStaffId, "/stock-transfers", {
    method: "POST",
    body: transferBody,
  });
  assert.equal(delegatedStaffTransfer.response.status, 201, JSON.stringify(delegatedStaffTransfer.data));
  fixtureTransferIds.push(delegatedStaffTransfer.data.id);
  assert.equal(
    (await api(legacyStaffId, `/stock-transfers/${delegatedStaffTransfer.data.id}`, {
      method: "DELETE",
    })).response.status,
    403,
  );

  await setStaffAccess(legacyRoomId, emptyStaffAccess);
  assert.equal((await api(legacyStaffId, "/inventory/movements")).response.status, 403);
  await setStaffAccess(legacyRoomId, { ...emptyStaffAccess, activity: "view" });
  assert.equal((await api(legacyStaffId, "/inventory/movements")).response.status, 200);
  await setStaffAccess(legacyRoomId, { ...emptyStaffAccess, activity: "edit" });
  assert.equal((await api(legacyStaffId, "/inventory/movements")).response.status, 200);
  assert.equal(
    (await api(legacyStaffId, "/users/security-events")).response.status,
    403,
    "Activity access must not expose manager-only security history.",
  );
  assert.equal(
    (await api(legacyStaffId, "/inventory/movements/1", {
      method: "DELETE",
    })).response.status,
    403,
  );

  await setStaffAccess(legacyRoomId, {
    ...emptyStaffAccess,
    products: "view",
  });
  await setStaffAccess(auditSiblingOutletId, {
    ...emptyStaffAccess,
    products: "view",
  });
  const mainOutletViewAccess = await api(legacyStaffId, "/products", {
    storeroomId: legacyRoomId,
  });
  const siblingOutletProductAccess = await api(legacyStaffId, "/products", {
    storeroomId: auditSiblingOutletId,
  });
  assert.equal(mainOutletViewAccess.response.status, 200);
  assert.equal(siblingOutletProductAccess.response.status, 200);
  assert.ok(
    siblingOutletProductAccess.data.some(
      ({ id }: { id: number }) => id === transferDestinationProduct.id,
    ),
  );
  const requestToUnassignedOutlet = await api(legacyStaffId, "/products", {
    storeroomId: secondRoomId,
  });
  assert.equal(requestToUnassignedOutlet.response.status, 200);
  assert.equal(
    requestToUnassignedOutlet.response.headers.get("X-Active-Outlet-Id"),
    String(legacyRoomId),
    "An outlet ID without membership must not switch the authenticated staff request.",
  );
});
