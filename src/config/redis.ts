import { Redis, type RedisOptions } from "ioredis";

const PRODUCER_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: 5,
  enableReadyCheck: true,
};

const WORKER_REDIS_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
};

/**
 * Shared connection used by BullMQ Queue instances (producers) and by
 * ad-hoc readiness checks. Workers must not reuse this connection.
 * worker process should call createRedisConnection() for its own.
 */
export const redis = new Redis(process.env.REDIS_URL, PRODUCER_REDIS_OPTIONS);

/**
 * A blocking-safe connection (maxRetriesPerRequest: null) for Workers and
 * QueueEvents.
 *
 * Redis Cloud caps concurrent clients, so callers should share one of these
 * across every BullMQ consumer in the process: BullMQ treats an instance it is
 * handed as `shared` and duplicates it once per consumer for the blocking
 * loop, so N workers cost 1 + N sockets rather than 2N.
 *
 * Pass `{ lazyConnect: true }` when the instance exists only to be duplicated
 * (QueueEvents duplicates unconditionally) — the original then never dials.
 */
export function createRedisConnection(overrides?: RedisOptions): Redis {
  return new Redis(process.env.REDIS_URL, { ...WORKER_REDIS_OPTIONS, ...overrides });
}
