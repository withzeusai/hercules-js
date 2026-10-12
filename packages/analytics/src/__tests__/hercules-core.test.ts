import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "../hercules-core";
import type { HerculesEvent } from "../schema";

interface CapturedPayload {
  sent_at: number;
  events: HerculesEvent[];
}

describe("Analytics core", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let analytics: Analytics | undefined;

  function sentPayloads(): CapturedPayload[] {
    return fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
  }

  function sentEvents(): HerculesEvent[] {
    return sentPayloads().flatMap((payload) => payload.events);
  }

  function createAnalytics(overrides: Record<string, unknown> = {}) {
    analytics = new Analytics({
      apiEndpoint: "/i",
      flushInterval: 1000,
      trackPerformance: false,
      ...overrides,
    });
    return analytics;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    localStorage.clear();
    document.cookie = "_hrc_vid=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    history.replaceState(null, "", "/");
  });

  afterEach(() => {
    analytics?.destroy();
    analytics = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends batches wrapped in a { sent_at, events } envelope", () => {
    createAnalytics().trackPageview();
    vi.advanceTimersByTime(1000);

    const payloads = sentPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.sent_at).toBe(Date.now());
    expect(payloads[0]!.events).toHaveLength(1);
  });

  it("builds pageview events with dimensions, session, and pageview id", () => {
    createAnalytics().trackPageview();
    vi.advanceTimersByTime(1000);

    const [event] = sentEvents();
    expect(event!.event_type).toBe("pageview");
    expect(event!.visitor_id).toBeTruthy();
    expect(event!.session_id).toBeTruthy();
    expect(event!.pageview_id).toBeTruthy();
    expect(event!.device_type).toBeTruthy();
    expect(event!.language).toBeTruthy();
    expect(event!.lib_version).toBeTruthy();
    expect(event!.prev_pageview_id).toBeUndefined();
  });

  it("links SPA pageviews via history and records the previous page's duration", () => {
    createAnalytics().trackPageview();
    vi.advanceTimersByTime(5000);

    history.pushState(null, "", "/pricing");
    vi.advanceTimersByTime(1000);

    const events = sentEvents().filter((e) => e.event_type === "pageview");
    expect(events).toHaveLength(2);
    const [first, second] = events;
    expect(second!.prev_pageview_id).toBe(first!.pageview_id);
    expect(second!.prev_pageview_pathname).toBe("/");
    expect(second!.prev_pageview_duration).toBe(5);
    expect(second!.url_path).toBe("/pricing");
  });

  it("does not capture a pageview when only the query string changes", () => {
    createAnalytics().trackPageview();
    history.pushState(null, "", "/?tab=2");
    vi.advanceTimersByTime(1000);
    expect(sentEvents().filter((e) => e.event_type === "pageview")).toHaveLength(1);
  });

  it("pageleave describes the ending pageview and flushes immediately", () => {
    const instance = createAnalytics();
    instance.trackPageview();
    vi.advanceTimersByTime(1000); // flushes the pageview
    vi.advanceTimersByTime(2000);
    instance.trackPageleave();

    const events = sentEvents();
    const pageview = events.find((e) => e.event_type === "pageview");
    const pageleave = events.find((e) => e.event_type === "pageleave");
    expect(pageleave).toBeDefined();
    expect(pageleave!.prev_pageview_id).toBe(pageview!.pageview_id);
    expect(pageleave!.prev_pageview_duration).toBe(3);
  });

  it("custom events carry the current pageview id and share the session", () => {
    const instance = createAnalytics();
    instance.trackPageview();
    instance.track("signup_clicked", { plan: "pro", seats: 3 });
    vi.advanceTimersByTime(1000);

    const events = sentEvents();
    const pageview = events.find((e) => e.event_type === "pageview")!;
    const custom = events.find((e) => e.event_type === "custom")!;
    expect(custom.event_name).toBe("signup_clicked");
    expect(custom.pageview_id).toBe(pageview.pageview_id);
    expect(custom.session_id).toBe(pageview.session_id);
    expect(custom.properties).toMatchObject({ plan: "pro" });
    expect(custom.properties_numeric).toMatchObject({ seats: 3 });
  });

  it("coerces non-string, non-number property values to the flat wire format", () => {
    createAnalytics().track("checkout", {
      plan: "pro",
      seats: 3,
      newsletter: true,
      items: ["a", "b"],
      missing: null,
      skipped: undefined,
      broken: Number.NaN,
    });
    vi.advanceTimersByTime(1000);

    const [event] = sentEvents();
    expect(event!.properties).toMatchObject({
      plan: "pro",
      newsletter: "true",
      items: '["a","b"]',
    });
    expect(event!.properties_numeric).toEqual({ seats: 3 });
    expect(event!.properties).not.toHaveProperty("missing");
    expect(event!.properties).not.toHaveProperty("skipped");
    expect(event!.properties_numeric).not.toHaveProperty("broken");
  });

  it("persists the identified user across instances and only emits identify on change", () => {
    const first = createAnalytics();
    first.identify("user_123");
    first.identify("user_123"); // no-op: id unchanged
    vi.advanceTimersByTime(1000);

    const identifies = sentEvents().filter((e) => e.event_name === "identify");
    expect(identifies).toHaveLength(1);

    first.destroy();
    createAnalytics().track("after_reload");
    vi.advanceTimersByTime(1000);

    const afterReload = sentEvents().find((e) => e.event_name === "after_reload");
    expect(afterReload!.user_id).toBe("user_123");
  });

  it("reset clears the identified user but keeps the visitor id", () => {
    const instance = createAnalytics();
    instance.identify("user_123");
    instance.reset();
    instance.track("post_reset");
    vi.advanceTimersByTime(1000);

    const events = sentEvents();
    const identify = events.find((e) => e.event_name === "identify")!;
    const postReset = events.find((e) => e.event_name === "post_reset")!;
    expect(postReset.user_id).toBeUndefined();
    expect(postReset.visitor_id).toBe(identify.visitor_id);
    expect(postReset.session_id).not.toBe(identify.session_id);
  });

  it("reset(true) also rotates the visitor id", () => {
    const instance = createAnalytics();
    instance.track("before");
    instance.reset(true);
    instance.track("after");
    vi.advanceTimersByTime(1000);

    const events = sentEvents();
    const before = events.find((e) => e.event_name === "before")!;
    const after = events.find((e) => e.event_name === "after")!;
    expect(after.visitor_id).not.toBe(before.visitor_id);
    expect(document.cookie).toContain(`_hrc_vid=${after.visitor_id}`);
  });

  it("retries a failed batch with backoff", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    fetchMock.mockResolvedValue({ status: 503 });

    createAnalytics().trackPageview();
    vi.advanceTimersByTime(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // fetch resolves on a microtask; run timers + microtasks past the 12s backoff
    return vi.advanceTimersByTimeAsync(15_000).then(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retried = JSON.parse(fetchMock.mock.calls[1]![1].body) as CapturedPayload;
      expect(retried.events[0]!.event_type).toBe("pageview");
    });
  });

  it("retries a hidden-tab flush whose beacon was rejected and fallback fetch failed", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sendBeacon = vi.fn().mockReturnValue(false); // beacon queue rejects
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    fetchMock.mockResolvedValue({ status: 503 });

    const instance = createAnalytics();
    instance.trackPageview();
    instance.flush("sendBeacon");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the fallback fetch

    // The failed fallback must enter the retry queue even though the
    // requested transport was sendBeacon — the page is still alive
    return vi.advanceTimersByTimeAsync(15_000).then(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      delete (navigator as { sendBeacon?: unknown }).sendBeacon;
    });
  });

  it("destroy stops history tracking", () => {
    const instance = createAnalytics();
    instance.trackPageview();
    vi.advanceTimersByTime(1000);
    instance.destroy();
    analytics = undefined;

    history.pushState(null, "", "/after-destroy");
    vi.advanceTimersByTime(5000);
    expect(sentEvents().filter((e) => e.event_type === "pageview")).toHaveLength(1);
  });

  it("does nothing when disabled", () => {
    createAnalytics({ enabled: false }).trackPageview();
    vi.advanceTimersByTime(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
