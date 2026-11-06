import { createPublicTrackingRouter } from "./public-tracking";
import { writeStore } from "@/services/write-store";
import { Hono } from "hono";
import { apiProtection } from "../services/api-protection";

export const trackingRouter = new Hono();
trackingRouter.use("*", apiProtection("tracking", "peer"));
trackingRouter.route("/", createPublicTrackingRouter(writeStore));
