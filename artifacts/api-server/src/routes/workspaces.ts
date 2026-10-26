import { and, asc, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CompleteWorkspaceSetupBody,
  CompleteWorkspaceSetupResponse,
  UpdateWorkspaceBody,
  UpdateWorkspaceResponse,
} from "@workspace/api-zod";
import { db, storeroomsTable, workspacesTable } from "@workspace/db";
import { requireRoles } from "../middlewares/storeUser";

const router: IRouter = Router();

function trimContactEmailInput(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const body = input as Record<string, unknown>;
  return typeof body.contactEmail === "string"
    ? { ...body, contactEmail: body.contactEmail.trim() }
    : input;
}

router.patch(
  "/workspaces/me",
  requireRoles("owner"),
  async (req, res): Promise<void> => {
    const body = UpdateWorkspaceBody.safeParse(trimContactEmailInput(req.body));
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const name = body.data.name.trim();
    if (!name || name.length > 80) {
      res.status(400).json({
        error: "Workspace name must be between 1 and 80 characters.",
      });
      return;
    }
    const contactEmail = body.data.contactEmail?.trim().toLowerCase() || null;
    const contactPhone = body.data.contactPhone?.trim() || null;
    const businessAddress = body.data.businessAddress?.trim() || null;

    const [current] = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, req.workspaceId!))
      .limit(1);
    if (!current || current.ownerUserId !== req.storeUser!.id) {
      res.status(403).json({ error: "Only the workspace owner can update settings." });
      return;
    }

    const [workspace] = await db
      .update(workspacesTable)
      .set({ name, contactEmail, contactPhone, businessAddress })
      .where(eq(workspacesTable.id, current.id))
      .returning();
    res.json(
      UpdateWorkspaceResponse.parse({
        id: workspace.id,
        name: workspace.name,
        contactEmail: workspace.contactEmail,
        contactPhone: workspace.contactPhone,
        businessAddress: workspace.businessAddress,
        setupComplete: workspace.setupComplete,
        isOwner: true,
      }),
    );
  },
);

router.patch(
  "/workspaces/me/setup",
  requireRoles("owner"),
  async (req, res): Promise<void> => {
    const body = CompleteWorkspaceSetupBody.safeParse(trimContactEmailInput(req.body));
    if (!body.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of body.error.issues) {
        const field = issue.path[0];
        if (typeof field !== "string" || field in fieldErrors) continue;
        switch (field) {
          case "name":
            fieldErrors.name = "Enter a workspace name up to 80 characters long.";
            break;
          case "contactEmail":
            fieldErrors.contactEmail = "Enter a valid business email address, or leave it blank.";
            break;
          case "contactPhone":
            fieldErrors.contactPhone = "Enter a phone number up to 40 characters long.";
            break;
          case "businessAddress":
            fieldErrors.businessAddress = "Enter an address up to 500 characters long.";
            break;
          case "firstOutletName":
            fieldErrors.firstOutletName = "Enter an outlet name up to 80 characters long.";
            break;
        }
      }
      res.status(400).json({
        error: "Review the highlighted fields and try again.",
        fieldErrors,
      });
      return;
    }

    const name = body.data.name.trim();
    const firstOutletName = body.data.firstOutletName.trim();
    const fieldErrors: Record<string, string> = {};
    if (!name) fieldErrors.name = "Enter a workspace name.";
    if (!firstOutletName) fieldErrors.firstOutletName = "Enter an outlet name.";
    if (Object.keys(fieldErrors).length) {
      res.status(400).json({
        error: "Review the highlighted fields and try again.",
        fieldErrors,
      });
      return;
    }

    const [current] = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.id, req.workspaceId!))
      .limit(1);
    if (!current || current.ownerUserId !== req.storeUser!.id) {
      res.status(403).json({ error: "Only the workspace owner can complete registration." });
      return;
    }

    const [firstOutlet] = await db
      .select()
      .from(storeroomsTable)
      .where(and(
        eq(storeroomsTable.workspaceId, current.id),
        eq(storeroomsTable.ownerUserId, req.storeUser!.id),
      ))
      .orderBy(asc(storeroomsTable.id))
      .limit(1);
    if (!firstOutlet) {
      res.status(409).json({ error: "No first outlet is available for this workspace." });
      return;
    }

    const contactEmail = body.data.contactEmail?.trim().toLowerCase() || null;
    const contactPhone = body.data.contactPhone?.trim() || null;
    const businessAddress = body.data.businessAddress?.trim() || null;
    let updatedWorkspace = current;
    await db.transaction(async (tx) => {
      [updatedWorkspace] = await tx
        .update(workspacesTable)
        .set({
          name,
          contactEmail,
          contactPhone,
          businessAddress,
          setupComplete: true,
        })
        .where(eq(workspacesTable.id, current.id))
        .returning();
      await tx
        .update(storeroomsTable)
        .set({ name: firstOutletName })
        .where(and(
          eq(storeroomsTable.id, firstOutlet.id),
          eq(storeroomsTable.workspaceId, current.id),
        ));
    });

    res.json(
      CompleteWorkspaceSetupResponse.parse({
        id: updatedWorkspace.id,
        name: updatedWorkspace.name,
        contactEmail: updatedWorkspace.contactEmail,
        contactPhone: updatedWorkspace.contactPhone,
        businessAddress: updatedWorkspace.businessAddress,
        setupComplete: updatedWorkspace.setupComplete,
        isOwner: true,
      }),
    );
  },
);

export default router;
