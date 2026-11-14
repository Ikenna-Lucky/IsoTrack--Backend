import { Hono } from "hono";
import { authenticate } from "../middleware/auth";
import { writeStore } from "../services/write-store";
import {
  createCollectionRouter,
  createNotificationMutationRouter,
} from "./collections";

export const notificationsRouter = new Hono();
notificationsRouter.use("*", authenticate);
notificationsRouter.route(
  "/",
  createCollectionRouter(writeStore, "notifications"),
);
notificationsRouter.route("/", createNotificationMutationRouter(writeStore));
