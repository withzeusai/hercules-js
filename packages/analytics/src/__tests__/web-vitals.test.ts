import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_VITALS_FLUSH_MS } from "../constants";
import { WebVitalsCapture } from "../web-vitals";

describe("WebVitalsCapture without PerformanceObserver", () => {
  let capture: WebVitalsCapture | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Force the no-PerformanceObserver path regardless of the jsdom version
    vi.stubGlobal("PerformanceObserver", undefined);
  });

  afterEach(() => {
    capture?.stop();
    capture = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("still flushes Navigation Timing metrics", () => {
    vi.spyOn(performance, "getEntriesByType").mockImplementation((type: string) =>
      type === "navigation"
        ? [
            {
              loadEventEnd: 1200,
              fetchStart: 100,
              domInteractive: 600,
              responseStart: 250,
              requestStart: 150,
            } as unknown as PerformanceEntry,
          ]
        : [],
    );

    const onFlush = vi.fn();
    capture = new WebVitalsCapture(onFlush);

    vi.advanceTimersByTime(WEB_VITALS_FLUSH_MS);
    expect(onFlush).toHaveBeenCalledWith({
      plt: 1100,
      di: 500,
      ttfb: 100,
    });
  });

  it("does not emit an event when no metrics are available at all", () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);
    const onFlush = vi.fn();
    capture = new WebVitalsCapture(onFlush);

    vi.advanceTimersByTime(WEB_VITALS_FLUSH_MS);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
