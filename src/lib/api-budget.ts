import type Redis from "ioredis";

const reserve = `
local count = redis.call('GET', KEYS[1])
local window = tonumber(ARGV[2])
if not count then
  redis.call('SET', KEYS[1], 1, 'PX', window)
  return {1, window}
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then return redis.error_reply('Invalid budget expiry') end
if tonumber(count) >= tonumber(ARGV[1]) then return {0, ttl} end
redis.call('INCR', KEYS[1])
return {1, ttl}
`;

export interface ApiBudget {
  consume(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; retryAfter: number }>;
}
export function createRedisBudget(redis: Pick<Redis, "eval">): ApiBudget {
  return {
    async consume(key, limit, windowMs) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        !Number.isSafeInteger(windowMs) ||
        windowMs < 1 ||
        windowMs > 3600000
      )
        throw new Error("Invalid API budget policy");
      const result: unknown = await redis.eval(
        reserve,
        1,
        key,
        limit,
        windowMs,
      );
      if (
        !Array.isArray(result) ||
        result.length !== 2 ||
        ![0, 1].includes(result[0]) ||
        !Number.isSafeInteger(result[1]) ||
        result[1] < 0 ||
        result[1] > windowMs
      )
        throw new Error("Invalid API budget result");
      return {
        allowed: result[0] === 1,
        retryAfter: Math.max(1, Math.ceil(result[1] / 1000)),
      };
    },
  };
}
