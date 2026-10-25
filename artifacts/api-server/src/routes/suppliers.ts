import { and, asc, eq, ne } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreateSupplierBody,
  CreateSupplierResponse,
  ListSuppliersResponse,
  UpdateSupplierBody,
  UpdateSupplierParams,
  UpdateSupplierResponse,
} from "@workspace/api-zod";
import { db, suppliersTable } from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";

const router: IRouter = Router();

router.get("/suppliers", async (req, res): Promise<void> => {
  const suppliers = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.storeroomId, req.storeroomId!))
    .orderBy(asc(suppliersTable.name));
  res.json(ListSuppliersResponse.parse(suppliers));
});

router.post(
  "/suppliers",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const body = CreateSupplierBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const name = body.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Supplier name cannot be blank." });
      return;
    }
    const [duplicate] = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(and(
        eq(suppliersTable.storeroomId, req.storeroomId!),
        eq(suppliersTable.name, name),
      ))
      .limit(1);
    if (duplicate) {
      res.status(409).json({ error: "A supplier with this name already exists in this outlet." });
      return;
    }
    const [supplier] = await db
      .insert(suppliersTable)
      .values({
        ...body.data,
        name,
        contactName: body.data.contactName?.trim() || null,
        phone: body.data.phone?.trim() || null,
        email: body.data.email?.trim().toLowerCase() || null,
        notes: body.data.notes?.trim() || null,
        storeroomId: req.storeroomId!,
      })
      .returning();
    res.status(201).json(CreateSupplierResponse.parse(supplier));
  },
);

router.patch(
  "/suppliers/:supplierId",
  requireRoles("owner", "admin", "supervisor"),
  async (req, res): Promise<void> => {
    const params = UpdateSupplierParams.safeParse(req.params);
    const body = UpdateSupplierBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    if (!Object.keys(body.data).length) {
      res.status(400).json({ error: "Provide at least one supplier field." });
      return;
    }
    const [existing] = await db
      .select({ id: suppliersTable.id })
      .from(suppliersTable)
      .where(and(
        eq(suppliersTable.id, params.data.supplierId),
        eq(suppliersTable.storeroomId, req.storeroomId!),
      ))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Supplier not found." });
      return;
    }
    const changes = {
      ...body.data,
      ...(body.data.name !== undefined ? { name: body.data.name.trim() } : {}),
      ...(body.data.contactName !== undefined ? { contactName: body.data.contactName?.trim() || null } : {}),
      ...(body.data.phone !== undefined ? { phone: body.data.phone?.trim() || null } : {}),
      ...(body.data.email !== undefined ? { email: body.data.email?.trim().toLowerCase() || null } : {}),
      ...(body.data.notes !== undefined ? { notes: body.data.notes?.trim() || null } : {}),
    };
    if (changes.name === "") {
      res.status(400).json({ error: "Supplier name cannot be blank." });
      return;
    }
    if (changes.name !== undefined) {
      const [duplicate] = await db
        .select({ id: suppliersTable.id })
        .from(suppliersTable)
        .where(and(
          eq(suppliersTable.storeroomId, req.storeroomId!),
          eq(suppliersTable.name, changes.name),
          ne(suppliersTable.id, params.data.supplierId),
        ))
        .limit(1);
      if (duplicate) {
        res.status(409).json({ error: "A supplier with this name already exists in this outlet." });
        return;
      }
    }
    const [updated] = await db
      .update(suppliersTable)
      .set(changes)
      .where(and(
        eq(suppliersTable.id, params.data.supplierId),
        eq(suppliersTable.storeroomId, req.storeroomId!),
      ))
      .returning();
    res.json(UpdateSupplierResponse.parse(updated));
  },
);

export default router;
