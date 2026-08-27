import { UnrecoverableError } from "bullmq";
import type { z } from "zod";

/**
 * Parses a job payload, treating a malformed one as terminal.
 *
 * A payload that does not match its schema will not match it on the next
 * attempt either — the job data is fixed once the job is created. Throwing a
 * plain ZodError would let BullMQ burn all three attempts (and two backoff
 * delays) rediscovering that, so this raises UnrecoverableError instead, which
 * BullMQ moves straight to the failed set.
 *
 * Producers already validate against the same schema before enqueueing
 * (src/queues/connection.ts), so reaching here means the payload was written by
 * something that bypassed `enqueue` — worth failing loudly and immediately.
 */
export function parseJobData<T>(schema: z.ZodType<T>, data: unknown, queueName: string): T {
  const parsed = schema.safeParse(data);

  if (!parsed.success) {
    throw new UnrecoverableError(
      `Invalid ${queueName} job payload: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`,
    );
  }

  return parsed.data;
}
