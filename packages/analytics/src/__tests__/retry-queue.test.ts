import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RETRIES } from "../constants";
import { RetryQueue } from "../retry-queue";
import type { HerculesEvent } from "../schema";

const events = [{ event_id: "a" } as HerculesEvent];

describe("RetryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic jitter: 0.5 + 0.5 = 1x the base delay
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries after an exponential backoff delay", () => {
    const send = vi.fn();
    const queue = new RetryQueue(send);

    queue.enqueue(events, 0);
    // first retry: 6s * 2^1 = 12s
    vi.advanceTimersByTime(10_000);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_000);
    expect(send).toHaveBeenCalledWith(events, 1);
    queue.stop();
  });

  it("drops a batch after the retry limit", () => {
    const send = vi.fn();
    const queue = new RetryQueue(send);
    queue.enqueue(events, MAX_RETRIES);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(send).not.toHaveBeenCalled();
    queue.stop();
  });

  it("drains immediately when the browser comes back online", () => {
    const send = vi.fn();
    const queue = new RetryQueue(send);
    queue.enqueue(events, 0);
    window.dispatchEvent(new Event("online"));
    expect(send).toHaveBeenCalledWith(events, 1);
    queue.stop();
  });

  it("ignores enqueues after stop (a failed destroy-time flush must not revive the poller)", () => {
    const send = vi.fn();
    const queue = new RetryQueue(send);
    queue.stop();
    queue.enqueue(events, 0);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands queued batches to sendBeacon on unload", () => {
    const send = vi.fn();
    const sendBeacon = vi.fn();
    const queue = new RetryQueue(send);
    queue.enqueue(events, 0);
    queue.unload(sendBeacon);
    expect(sendBeacon).toHaveBeenCalledWith(events);
    expect(send).not.toHaveBeenCalled();
    queue.stop();
  });
});
