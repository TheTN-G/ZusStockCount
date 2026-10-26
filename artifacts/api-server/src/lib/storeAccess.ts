export const storeAccessModules = [
  "dashboard",
  "receiving",
  "deliveryRecords",
  "products",
  "suppliers",
  "stockTransfers",
  "purchaseOrders",
  "approvals",
  "activity",
  "stockCount",
] as const;

export type StoreAccessModule = (typeof storeAccessModules)[number];
export type StoreAccessLevel = "none" | "view" | "edit";
export type StoreAccess = Record<StoreAccessModule, StoreAccessLevel>;

const defaultStaffAccess: StoreAccess = {
  dashboard: "view",
  receiving: "edit",
  deliveryRecords: "view",
  products: "view",
  suppliers: "view",
  stockTransfers: "none",
  purchaseOrders: "edit",
  approvals: "view",
  activity: "view",
  stockCount: "edit",
};

const fullAccess: StoreAccess = Object.fromEntries(
  storeAccessModules.map((module) => [module, "edit"]),
) as StoreAccess;

export function effectiveStoreAccess(
  role: string,
  value: unknown,
): StoreAccess {
  const defaults = role === "staff" ? defaultStaffAccess : fullAccess;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...defaults };
  }
  const provided = value as Record<string, unknown>;
  return Object.fromEntries(
    storeAccessModules.map((module) => [
      module,
      provided[module] === "none" ||
      provided[module] === "view" ||
      provided[module] === "edit"
        ? provided[module]
        : defaults[module],
    ]),
  ) as StoreAccess;
}

export function accessModuleForRequest(
  path: string,
  method: string,
): StoreAccessModule | null {
  if (path === "/dashboard/summary" || path.startsWith("/dashboard/")) {
    return "dashboard";
  }
  if (
    path.startsWith("/products") ||
    path.startsWith("/product-categories") ||
    path.startsWith("/stock-sections") ||
    path.startsWith("/inventory/batches") ||
    path.startsWith("/inventory/adjust")
  ) {
    return "products";
  }
  if (path.startsWith("/suppliers")) return "suppliers";
  if (path.startsWith("/stock-transfers")) return "stockTransfers";
  if (path.startsWith("/stock-counts")) return "stockCount";
  if (path.startsWith("/inventory/movements")) return "activity";
  if (path.startsWith("/deliveries")) {
    if (/\/(review|decision)$/.test(path)) return "approvals";
    if (method.toUpperCase() === "POST" && path === "/deliveries") {
      return "receiving";
    }
    return "deliveryRecords";
  }
  if (path.startsWith("/purchase-orders")) {
    if (/\/(review|decision|approve)$/.test(path)) return "approvals";
    return "purchaseOrders";
  }
  return null;
}

export function staffMayAccessRequest(
  path: string,
  method: string,
  permissions: unknown,
): boolean {
  const module = accessModuleForRequest(path, method);
  if (!module || method.toUpperCase() === "DELETE") return false;
  const access = effectiveStoreAccess("staff", permissions);
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    if (access[module] !== "none") return true;
    if (
      path.startsWith("/purchase-orders") &&
      access.approvals !== "none"
    ) {
      return true;
    }
    if (
      path.startsWith("/deliveries") &&
      (access.approvals !== "none" || access.receiving !== "none")
    ) return true;
    return false;
  }
  return access[module] === "edit";
}

export function accessDenialForRequest(
  role: string,
  permissions: unknown,
  path: string,
  method: string,
): string | null {
  const module = accessModuleForRequest(path, method);
  if (!module || role === "owner" || role === "admin" || role === "supervisor") {
    return null;
  }
  const access = effectiveStoreAccess(role, permissions);
  const level = access[module];
  const isRead = ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  if (
    isRead &&
    path.startsWith("/purchase-orders") &&
    access.approvals !== "none"
  ) {
    return null;
  }
  if (
    isRead &&
    path.startsWith("/deliveries") &&
    (access.approvals !== "none" || access.receiving !== "none")
  ) return null;
  if (level === "none") return "This section is not available to your account.";
  if (method.toUpperCase() === "DELETE") {
    return "Only an owner, admin, or manager can delete records.";
  }
  if (!isRead && level !== "edit") {
    return "Your account can view this section but cannot make changes.";
  }
  return null;
}
