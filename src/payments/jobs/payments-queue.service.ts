import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';
import {
  PAYMENTS_QUEUE,
  PAYMENTS_QUEUE_PROBE_JOB,
  type PaymentsQueueProbeJobData,
  type PaymentsQueueProbeResult,
} from './payments-queue.js';

/**
 * The API side of the payments queue (Step 26): everything that puts a job *on* it.
 *
 * A service rather than `@InjectQueue(...) private queue: Queue` wherever a job is needed, for
 * the reason this file exists at all: a caller holding the raw queue can add any name with any
 * options, and nothing stops it - BullMQ's types are per-payload and say nothing about which
 * names have handlers. Here the names and the per-job options have one home, and the day there
 * are two enqueues they are two methods in one file that can be read together.
 *
 * What is deliberately *not* here is the submission enqueue. The build sequence gates Step 27
 * on a proposal because the payload, the attempts/backoff policy and the retention of a
 * submission job are decisions that interact with idempotency, and a queue with no
 * `defaultJobOptions` is a queue that has made no decision yet - which is the correct state to
 * hand Step 27 rather than a default it would have to notice and argue with. The probe below
 * carries its own options for exactly that reason: they are about the probe, not the queue.
 *
 * Its callers today are the readiness path - `test/queue.e2e-spec.ts`, and the same question
 * asked by hand against a running deployment - which is a thin consumer for a production
 * provider, and is stated rather than hidden: the alternative (letting a test reach for the
 * queue token directly) would test a path the application does not actually use.
 */
@Injectable()
export class PaymentsQueueService {
  private readonly logger = new Logger(PaymentsQueueService.name);

  constructor(
    @InjectQueue(PAYMENTS_QUEUE)
    private readonly queue: Queue<PaymentsQueueProbeJobData, PaymentsQueueProbeResult>,
  ) {}

  /**
   * Adds the probe job and returns it, so the caller can wait for the worker's answer:
   * `await job.waitUntilFinished(queueEvents)`.
   *
   * `removeOnComplete: true` is set per job rather than on the queue, and it is the promise
   * that makes a probe worth having: it can be fired as often as someone wants to know whether
   * the worker is alive, and each answer disappears as it is read instead of accumulating in
   * Redis. Nothing else is configured - no attempts, no backoff - because a probe that needs
   * retrying is a probe that is telling you something, and that answer is more useful in a log
   * line than hidden behind three silent retries.
   */
  async enqueueProbe(): Promise<Job<PaymentsQueueProbeJobData, PaymentsQueueProbeResult>> {
    const job = await this.queue.add(PAYMENTS_QUEUE_PROBE_JOB, {}, { removeOnComplete: true });

    this.logger.log(`Probe job ${job.id} added to the ${PAYMENTS_QUEUE} queue`);

    return job;
  }
}
