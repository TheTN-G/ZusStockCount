import { Router, type IRouter } from "express";
import {
  CreateOutletBody,
  CreateOutletResponse,
  UpdateOutletBody,
  UpdateOutletParams,
  UpdateOutletResponse,
} from "@workspace/api-zod";
import {
  db,
  storeroomMembershipsTable,
  storeroomsTable,
  workspacesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireRoles } from "../middlewares/storeUser";

const router: IRouter = Router();

router.post(
  "/outlets",
  requireRoles("owner"),
  async (req, res): Promise<void> => {
    const body = CreateOutletBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const name = body.data.name.trim();
    if (!name || name.length > 80) {
      res.status(400).json({ error: "Outlet name must be between 1 and 80 characters." });
      return;
    }
    const [workspace] = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, req.workspaceId!))
      .limit(1);
    if (!workspace || workspace.ownerUserId !== req.storeUser!.id) {
      res.status(403).json({ error: "Only the workspace owner can add outlets." });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [room] = await tx
        .insert(storeroomsTable)
        .values({
          workspaceId: workspace.id,
          name,
          ownerUserId: workspace.ownerUserId,
        })
        .returning();
      await tx.insert(storeroomMembershipsTable).values({
        storeroomId: room.id,
        userId: req.storeUser!.id,
        role: "owner",
      });
      return {
        id: room.id,
        name: room.name,
        role: "owner",
        contactEmail: room.contactEmail,
        contactPhone: room.contactPhone,
        businessAddress: room.businessAddress,
      };
    });

    res.status(201).json(CreateOutletResponse.parse(result));
  },
);

router.patch(
  "/outlets/:outletId",
  requireRoles("owner", "supervisor"),
  async (req, res): Promise<void> => {
    const params = UpdateOutletParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpdateOutletBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const [existingOutlet] = await db
      .select({ id: storeroomsTable.id })
      .from(storeroomsTable)
      .where(
        and(
          eq(storeroomsTable.id, params.data.outletId),
          eq(storeroomsTable.workspaceId, req.workspaceId!),
        ),
      )
      .limit(1);
    if (!existingOutlet) {
      res.status(404).json({ error: "Outlet not found in this workspace." });
      return;
    }

    if (req.storeMembership!.role === "supervisor") {
      if (existingOutlet.id !== req.storeroomId) {
        res.status(404).json({ error: "Outlet not found in this workspace." });
        return;
      }
    } else {
      const [workspace] = await db
        .select({ ownerUserId: workspacesTable.ownerUserId })
        .from(workspacesTable)
        .where(eq(workspacesTable.id, req.workspaceId!))
        .limit(1);
      if (!workspace || workspace.ownerUserId !== req.storeUser!.id) {
        res.status(403).json({ error: "Only the workspace owner can update outlet details." });
        return;
      }
    }

    const [outlet] = await db
      .update(storeroomsTable)
      .set(body.data)
      .where(
        and(
          eq(storeroomsTable.id, existingOutlet.id),
          eq(storeroomsTable.workspaceId, req.workspaceId!),
        ),
      )
      .returning();
    res.json(
      UpdateOutletResponse.parse({
        id: outlet.id,
        name: outlet.name,
        role: req.storeMembership!.role,
        contactEmail: outlet.contactEmail,
        contactPhone: outlet.contactPhone,
        businessAddress: outlet.businessAddress,
      }),
    );
  },
);

export default router;
