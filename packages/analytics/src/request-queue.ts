// Batching queue following posthog-js request-queue.ts: events accumulate and
// flush after a short interval (scheduled lazily, so idle tabs run no timers)
// or as soon as the batch-size threshold is hit. `unload()` drains everything
// synchronously via sendBeacon.

import type { HerculesEvent } from "./schema";
import type { Transport } from "./request";

export type SendBatch = (events: HerculesEvent[], transport?: Transport) => void;

export class RequestQueue {
  private queue: HerculesEvent[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly flushIntervalMs: number,
    private readonly maxBatchSize: number,
    private readonly sendBatch: SendBatch,
  ) {}

  enqueue(event: HerculesEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.maxBatchSize) {
      this.flush();
    } else if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  flush(transport?: Transport): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = undefined;
    }
    if (this.queue.length === 0) {
      return;
    }
    const events = this.queue;
    this.queue = [];
    this.sendBatch(events, transport);
  }

  /** Drain everything with sendBeacon; the page is going away. */
  unload(): void {
    this.flush("sendBeacon");
  }

  stop(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = undefined;
    }
  }
}
