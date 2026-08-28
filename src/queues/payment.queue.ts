import type { JobsOptions } from "bullmq";
import { QUEUE_NAMES } from "../config/constants.js";
import { type PaymentJob, paymentJobSchema } from "../types/types.js";
import { createQueue, enqueue } from "./connection.js";

export const paymentQueue = createQueue<PaymentJob>(QUEUE_NAMES.PAYMENT);

export const PAYMENT_JOBS = {
  PROCESS_PAYMENT: "process-payment",
} as const;

/**
 * Payment is enqueued from three places — the matching worker's success path,
 * its heal path for a committed match whose job was lost, and exception
 * resolution. Without a stable job id BullMQ treats those as distinct jobs, and
 * two of them can be in flight for one invoice at once; the only thing then
 * separating them is claimPaymentForProcessing's lease, which cannot tell a
 * crashed attempt from a live one. Keying the job on the invoice makes BullMQ
 * collapse concurrent enqueues into a single job, so the lease is a backstop
 * rather than the primary defence.
 *
 * An explicit `jobId` in `opts` still wins, and `removeOnComplete` means a later
 * genuine re-drive of the same invoice can claim the id again once the first
 * job has left the queue.
 *
 * The separator is a dash, not a colon: BullMQ reserves ":" for its own Redis
 * key structure and rejects a custom job id containing one ("Custom Id cannot
 * contain :").
 */
export function enqueuePayment(payload: PaymentJob, opts?: JobsOptions): Promise<string> {
  return enqueue(paymentQueue, PAYMENT_JOBS.PROCESS_PAYMENT, paymentJobSchema, payload, {
    jobId: `payment-${payload.invoiceId}`,
    ...opts,
  });
}
