import { createPublicTrackingRouter } from "./public-tracking";
import { writeStore } from "@/services/write-store";

export const trackingRouter = createPublicTrackingRouter(writeStore);
