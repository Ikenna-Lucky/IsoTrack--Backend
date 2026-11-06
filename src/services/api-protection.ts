import IORedis from "ioredis";
import { env } from "../lib/env";
import { createRedisBudget } from "../lib/api-budget";
import { createApiProtection } from "../middleware/api-protection";
import { requestPeer } from "../middleware/request-peer";
import { reportDependency } from "../observability/runtime";

const redis = new IORedis(env.UPSTASH_REDIS_URL, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  connectTimeout: 1000,
  commandTimeout: 1000,
  retryStrategy: (times) => Math.min(times * 100, 2000),
});
redis.on("error", () => {});
void redis.connect().catch(() => {});
export const apiProtection = createApiProtection({
  budget: createRedisBudget(redis),
  secret: env.JWT_SECRET,
  peer: requestPeer,
  reportFailure: () => reportDependency("api_budget"),
});
export const closeApiProtection = () => redis.disconnect();
