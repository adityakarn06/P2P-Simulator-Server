import { type JobsOptions, Queue } from "bullmq";
import { z } from "zod";
import { DEFAULT_JOB_OPTIONS, type QueueName } from "../config/constants.js";
import { redis } from "../config/redis.js";
import { AppError } from "../utils/AppError.js";
import { closeQueueEvents } from "./jobResult.js";

const registry: Queue[] = [];

export function createQueue<T>(name: QueueName): Queue<T, unknown, string, T, unknown, string> {
  const queue = new Queue<T, unknown, string, T, unknown, string>(name, {
    connection: redis,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  registry.push(queue);
  return queue;
}

/**
 * Validates a job payload against its Zod schema before adding it to the
 * queue. Job payloads must carry IDs only — workers re-fetch current state
 * from PostgreSQL rather than trusting queued data.
 */
/**
 * `TIn` is separate from `T` because a payload schema may carry defaults — the
 * payment queue's `settlementKey` does — so what a caller supplies is a looser
 * shape than what the worker receives. Parsing here is what closes the gap, and
 * it stays the only place a job payload is validated (CLAUDE.md rule 8).
 */
export async function enqueue<T, TIn = T>(
  queue: Queue<T, unknown, string, T, unknown, string>,
  jobName: string,
  schema: z.ZodType<T, TIn>,
  payload: TIn,
  opts?: JobsOptions,
): Promise<string> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      "QUEUE_ERROR",
      `Invalid job payload for queue "${queue.name}"`,
      z.flattenError(parsed.error).fieldErrors,
    );
  }

  const job = await queue.add(jobName, parsed.data, opts);
  if (!job.id) {
    throw AppError.internal(`Job added to queue "${queue.name}" was not assigned an id`);
  }
  return job.id;
}

export async function closeQueues(): Promise<void> {
  await closeQueueEvents();
  await Promise.all(registry.map((queue) => queue.close()));
}
