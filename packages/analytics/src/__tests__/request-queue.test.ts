import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestQueue } from "../request-queue";
import type { HerculesEvent } from "../schema";

function fakeEvent(id: string): HerculesEvent {
  return { event_id: id } as HerculesEvent;
}

describe("RequestQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushes after the flush interval", () => {
    const send = vi.fn();
    const queue = new RequestQueue(3000, 10, send);

    queue.enqueue(fakeEvent("a"));
    queue.enqueue(fakeEvent("b"));
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toHaveLength(2);
  });

  it("flushes immediately when the batch size is reached", () => {
    const send = vi.fn();
    const queue = new RequestQueue(3000, 2, send);
    queue.enqueue(fakeEvent("a"));
    queue.enqueue(fakeEvent("b"));
    expect(send).toHaveBeenCalledTimes(1);
    // and the timer that was scheduled by the first event is cancelled
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("unload drains everything via sendBeacon", () => {
    const send = vi.fn();
    const queue = new RequestQueue(3000, 10, send);
    queue.enqueue(fakeEvent("a"));
    queue.unload();
    expect(send).toHaveBeenCalledWith([expect.objectContaining({ event_id: "a" })], "sendBeacon");
  });

  it("does not send empty batches", () => {
    const send = vi.fn();
    const queue = new RequestQueue(3000, 10, send);
    queue.flush();
    queue.unload();
    expect(send).not.toHaveBeenCalled();
  });
});
