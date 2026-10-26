import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  productCategoriesTable,
  productsTable,
  purchaseOrderLinesTable,
  purchaseOrdersTable,
  stockBatchesTable,
  stockCountLinesTable,
  stockCountsTable,
  stockMovementsTable,
  stockSectionsTable,
  stockTransfersTable,
  securityEventsTable,
  passwordResetTokensTable,
  suppliersTable,
  storeUsersTable,
  storeroomMembershipsTable,
  storeroomsTable,
  workspacesTable,
} from "@workspace/db";
import { createApiRouter } from "../src/routes";
import type { StoreAuthResolver } from "../src/middlewares/storeUser";

const fixtureTag = `api-isolation-${crypto.randomUUID()}`;
const legacyOwnerId = `${fixtureTag}-legacy-owner`;
const legacyStaffId = `${fixtureTag}-legacy-staff`;
const secondOwnerId = `${fixtureTag}-new-owner`;
const secondStaffId = `${fixtureTag}-new-staff`;
const secondManagerInviteeId = `${fixtureTag}-manager-invitee`;

let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;
let baseUrl: string;
let fixtureStoreroomIds: number[] = [];
let fixtureWorkspaceIds: number[] = [];
let fixtureProductIds: number[] = [];
let fixtureTransferIds: number[] = [];
let fixtureOrderIds: number[] = [];
let fixtureCountIds: number[] = [];
let fixtureUserIds = [
  legacyOwnerId,
  legacyStaffId,
  secondOwnerId,
  secondStaffId,
  secondManagerInviteeId,
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

async function api(
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
  const response = await fetch(`${baseUrl}/api${path}`, {
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

async function createProduct(userId: string, name: string, storeroomId?: number) {
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

  const order = await api(userId, "/purchase-orders", {
    method: "POST",
    body: { lines: [{ productId, quantity: 4 }] },
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
    db.select({ id: stockCountsTable.id }).from(stockCountsTable).limit(1),
    db.select({ id: securityEventsTable.id }).from(securityEventsTable).limit(1),
    db.select({ id: passwordResetTokensTable.id }).from(passwordResetTokensTable).limit(1),
  ]);
  assert.deepEqual(
    preexistingRows,
    [[], [], [], [], [], [], [], [], [], [], [], [], [], []],
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
  if (server) {
    server.close();
    await once(server, "close");
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
  if (fixtureOrderIds.length) {
    await db
      .delete(purchaseOrderLinesTable)
      .where(inArray(purchaseOrderLinesTable.orderId, fixtureOrderIds));
  }
  if (fixtureProductIds.length) {
    await db
      .delete(stockBatchesTable)
      .where(inArray(stockBatchesTable.productId, fixtureProductIds));
    await db
      .delete(stockMovementsTable)
      .where(inArray(stockMovementsTable.productId, fixtureProductIds));
  }
  if (fixtureCountIds.length) {
    await db.delete(stockCountsTable).where(inArray(stockCountsTable.id, fixtureCountIds));
  }
  if (fixtureOrderIds.length) {
    await db
      .delete(purchaseOrdersTable)
      .where(inArray(purchaseOrdersTable.id, fixtureOrderIds));
  }
  if (fixtureProductIds.length) {
    await db.delete(productsTable).where(inArray(productsTable.id, fixtureProductIds));
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
    createIssueDrafts(secondRoomId, mainSupplier.data.id, mainOutletProduct.id, 4),
    createIssueDrafts(secondOutletId, outletSupplier.data.id, outletProduct.id, 2),
  ]);
  const issueDrafts = async (storeroomId: number, orderIds: number[]) =>
    Promise.all(
      orderIds.map((orderId) =>
        api(secondOwnerId, `/purchase-orders/${orderId}/issue`, {
          method: "POST",
          storeroomId,
        }),
      ),
    );
  const [issuedMainOrders, issuedOutletOrders] = await Promise.all([
    issueDrafts(secondRoomId, mainDraftIds),
    issueDrafts(secondOutletId, outletDraftIds),
  ]);
  for (const issued of [...issuedMainOrders, ...issuedOutletOrders]) {
    assert.equal(issued.response.status, 200, JSON.stringify(issued.data));
    assert.equal(issued.data.status, "issued");
    assert.ok(issued.data.orderNumber, "An issued purchase order must have a number.");
  }
  const mainSequence = issuedMainOrders
    .map(({ data }) => data.orderNumber as string)
    .sort();
  const outletSequence = issuedOutletOrders
    .map(({ data }) => data.orderNumber as string)
    .sort();
  assert.deepEqual(
    mainSequence,
    [1, 2, 3, 4].map((sequence) => `${currentPrefix}${String(sequence).padStart(3, "0")}`),
    "Concurrent issues must have unique sequential numbers, starting fresh in the current month.",
  );
  assert.deepEqual(
    outletSequence,
    [1, 2].map((sequence) => `${currentPrefix}${String(sequence).padStart(3, "0")}`),
    "Each outlet must maintain its own monthly PO number sequence.",
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
  ]);
  const addedStaff = await api(secondOwnerId, "/users", {
    method: "POST",
    body: { email: `${secondStaffId}@example.invalid`, role: "staff" },
  });
  assert.equal(addedStaff.response.status, 201, JSON.stringify(addedStaff.data));
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
      [secondOutletId, "Airport Outlet"],
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
  assert.equal(outletSecurityEvents.data.length, 1);
  assert.equal(outletSecurityEvents.data[0].targetName, secondManagerInviteeId);

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
    assert.ok(ownOrders.data.some(({ id }: { id: number }) => id === ownRecords.orderId));
    assert.ok(!ownOrders.data.some(({ id }: { id: number }) => id === otherRecords.orderId));
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
        },
      },
    );
    assert.equal(submittedCount.response.status, 200);

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
      pendingApprovals: 3,
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
      pendingApprovals: 2,
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
            countedQuantity: expectedQuantity + (sectionId === sourceMain.id ? 2.5 : 0),
          }),
        ),
        acknowledgedMovementIds: refreshedSectionCount.data.movements.map(
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
});
