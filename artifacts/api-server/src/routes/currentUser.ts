import { and, asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import {
  db,
  storeroomMembershipsTable,
  storeroomsTable,
  workspacesTable,
} from "@workspace/db";

const router: IRouter = Router();

router.get("/me", async (req, res): Promise<void> => {
  const user = req.storeUser!;
  const [workspace] = await db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, req.workspaceId!))
    .limit(1);
  const outlets = await db
    .select({
      id: storeroomsTable.id,
      name: storeroomsTable.name,
      contactEmail: storeroomsTable.contactEmail,
      contactPhone: storeroomsTable.contactPhone,
      businessAddress: storeroomsTable.businessAddress,
      role: storeroomMembershipsTable.role,
    })
    .from(storeroomMembershipsTable)
    .innerJoin(
      storeroomsTable,
      eq(storeroomsTable.id, storeroomMembershipsTable.storeroomId),
    )
    .where(
      and(
        eq(storeroomMembershipsTable.userId, user.id),
        eq(storeroomsTable.workspaceId, req.workspaceId!),
      ),
    )
    .orderBy(
      asc(storeroomMembershipsTable.createdAt),
      asc(storeroomMembershipsTable.id),
    );
  res.json(
    GetCurrentUserResponse.parse({
      id: user.id,
      name: user.name,
      email: user.email,
      role: req.storeMembership!.role,
      storeName: req.storeroom!.name,
      activeStoreroomId: req.storeroomId!,
      storerooms: outlets,
      workspace: {
        id: workspace?.id ?? req.workspaceId!,
        name: workspace?.name ?? "Workspace",
        contactEmail: workspace?.contactEmail ?? null,
        contactPhone: workspace?.contactPhone ?? null,
        businessAddress: workspace?.businessAddress ?? null,
        setupComplete: workspace?.setupComplete ?? true,
        isOwner: workspace?.ownerUserId === user.id,
      },
      activeOutletId: req.storeroomId!,
      outlets,
    }),
  );
});

export default router;
