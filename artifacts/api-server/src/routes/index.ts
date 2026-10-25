import { Router, type IRouter } from "express";
import type { StoreAuthResolver } from "../middlewares/storeUser";
import healthRouter from "./health";
import currentUserRouter from "./currentUser";
import dashboardRouter from "./dashboard";
import productsRouter from "./products";
import inventoryRouter from "./inventory";
import ordersRouter from "./orders";
import countsRouter from "./counts";
import catalogueRouter from "./catalogue";
import stockTransfersRouter from "./stockTransfers";
import usersRouter from "./users";
import storeroomsRouter from "./storerooms";
import workspacesRouter from "./workspaces";
import suppliersRouter from "./suppliers";
import deliveriesRouter from "./deliveries";
import { createRequireStoreUser } from "../middlewares/storeUser";

export function createApiRouter(resolveAuth?: StoreAuthResolver): IRouter {
  const router: IRouter = Router();

  router.use(healthRouter);
  router.use(createRequireStoreUser(resolveAuth));
  router.use(currentUserRouter);
  router.use(storeroomsRouter);
  router.use(workspacesRouter);
  router.use(dashboardRouter);
  router.use(productsRouter);
  router.use(catalogueRouter);
  router.use(suppliersRouter);
  router.use(deliveriesRouter);
  router.use(inventoryRouter);
  router.use(stockTransfersRouter);
  router.use(ordersRouter);
  router.use(countsRouter);
  router.use(usersRouter);

  return router;
}

export default createApiRouter();
