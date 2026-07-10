// Retry queue following posthog-js retry-queue.ts: failed batches are retried
// with jittered exponential backoff (6s * 2^n, capped at 30 minutes, at most
// 10 attempts), a lazy 2s poller only runs while something is queued, sends
// are skipped while offline, and coming back online triggers an immediate
// drain. Duplicate deliveries are possible by design; the ingest table
// deduplicates on event_id.

import { MAX_RETRIES, RETRY_BASE_DELAY_MS, RETRY_MAX_DELAY_MS } from "./constants";
import { win, nav } from "./globals";
import type { HerculesEvent } from "./schema";

export type RetrySend = (events: HerculesEvent[], retriesPerformedSoFar: number) => void;

interface QueuedBatch {
  events: HerculesEvent[];
  retriesPerformedSoFar: number;
  retryAt: number;
}

const POLL_INTERVAL_MS = 2000;

function backoffDelayMs(retriesPerformedSoFar: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** retriesPerformedSoFar;
  // +/-50% jitter, matching posthog-js, so stampeding clients spread out
  const jitter = 0.5 + Math.random();
  return Math.min(RETRY_MAX_DELAY_MS, base * jitter);
}

export class RetryQueue {
  private queue: QueuedBatch[] = [];
  private poller: ReturnType<typeof setInterval> | undefined;
  private teardown: (() => void) | undefined;

  constructor(private readonly send: RetrySend) {
    if (win) {
      const listenerWin = win;
      const onOnline = () => this.drain();
      listenerWin.addEventListener("online", onOnline);
      this.teardown = () => listenerWin.removeEventListener("online", onOnline);
    }
  }

  enqueue(events: HerculesEvent[], retriesPerformedSoFar: number): void {
    const retries = retriesPerformedSoFar + 1;
    if (retries > MAX_RETRIES) {
      return;
    }
    this.queue.push({
      events,
      retriesPerformedSoFar: retries,
      retryAt: Date.now() + backoffDelayMs(retries),
    });
    this.startPollerIfNeeded();
  }

  private startPollerIfNeeded(): void {
    if (!this.poller) {
      this.poller = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }
  }

  private poll(): void {
    if (this.queue.length === 0) {
      this.stopPoller();
      return;
    }
    if (nav && nav.onLine === false) {
      return; // wait for the `online` event
    }
    const now = Date.now();
    const due = this.queue.filter((batch) => batch.retryAt <= now);
    if (due.length === 0) {
      return;
    }
    this.queue = this.queue.filter((batch) => batch.retryAt > now);
    for (const batch of due) {
      this.send(batch.events, batch.retriesPerformedSoFar);
    }
  }

  /** Retry everything immediately (used when the browser comes back online). */
  drain(): void {
    const batches = this.queue;
    this.queue = [];
    this.stopPoller();
    for (const batch of batches) {
      this.send(batch.events, batch.retriesPerformedSoFar);
    }
  }

  /** Last-gasp attempt at unload: hand queued batches to sendBeacon. */
  unload(sendBeacon: (events: HerculesEvent[]) => void): void {
    const batches = this.queue;
    this.queue = [];
    this.stopPoller();
    for (const batch of batches) {
      sendBeacon(batch.events);
    }
  }

  private stopPoller(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  stop(): void {
    this.stopPoller();
    this.teardown?.();
    this.teardown = undefined;
    this.queue = [];
  }
}
