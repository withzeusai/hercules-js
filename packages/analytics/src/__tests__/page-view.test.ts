import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PageViewManager } from "../page-view";
import type { ScrollManager, ScrollContext } from "../scroll-manager";

function stubScrollManager(context: ScrollContext | undefined) {
  return {
    getContext: () => context,
    resetContext: vi.fn(),
  } as unknown as ScrollManager;
}

describe("PageViewManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first pageview has an id but no prev_* properties", () => {
    const manager = new PageViewManager(stubScrollManager(undefined));
    const props = manager.doPageView(Date.now(), "pv_1");
    expect(props).toEqual({ pageview_id: "pv_1" });
  });

  it("second pageview links to the first with duration in seconds", () => {
    const scroll = stubScrollManager({ maxScrollY: 500, maxScrollHeight: 1000 });
    const manager = new PageViewManager(scroll);

    manager.doPageView(Date.now(), "pv_1");
    vi.advanceTimersByTime(12_500);
    const props = manager.doPageView(Date.now(), "pv_2");

    expect(props.pageview_id).toBe("pv_2");
    expect(props.prev_pageview_id).toBe("pv_1");
    expect(props.prev_pageview_duration).toBe(12.5);
    expect(props.prev_pageview_max_scroll_percentage).toBe(0.5);
    expect(scroll.resetContext).toHaveBeenCalledTimes(2);
  });

  it("pageleave describes the current (ending) pageview", () => {
    const manager = new PageViewManager(
      stubScrollManager({ maxScrollY: 999.5, maxScrollHeight: 1000 }),
    );
    manager.doPageView(Date.now(), "pv_1");
    vi.advanceTimersByTime(3000);
    const props = manager.doPageLeave(Date.now());

    expect(props.pageview_id).toBe("pv_1");
    expect(props.prev_pageview_id).toBe("pv_1");
    expect(props.prev_pageview_duration).toBe(3);
    // ceil(999.5) / 1000 = 1: scrolling within half a pixel counts as 100%
    expect(props.prev_pageview_max_scroll_percentage).toBe(1);
  });

  it("a page too short to scroll counts as fully scrolled", () => {
    const manager = new PageViewManager(stubScrollManager({ maxScrollY: 0, maxScrollHeight: 0 }));
    manager.doPageView(Date.now(), "pv_1");
    vi.advanceTimersByTime(1000);
    const props = manager.doPageLeave(Date.now());
    expect(props.prev_pageview_max_scroll_percentage).toBe(1);
  });

  it("other events carry only the current pageview id", () => {
    const manager = new PageViewManager(stubScrollManager(undefined));
    expect(manager.doEvent()).toEqual({});
    manager.doPageView(Date.now(), "pv_1");
    expect(manager.doEvent()).toEqual({ pageview_id: "pv_1" });
  });

  it("reset clears linking (used on session rotation)", () => {
    const manager = new PageViewManager(stubScrollManager(undefined));
    manager.doPageView(Date.now(), "pv_1");
    manager.reset();
    const props = manager.doPageView(Date.now(), "pv_2");
    expect(props.prev_pageview_id).toBeUndefined();
    expect(manager.doEvent()).toEqual({ pageview_id: "pv_2" });
  });
});
