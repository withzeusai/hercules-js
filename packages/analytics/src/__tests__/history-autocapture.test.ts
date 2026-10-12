import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryAutocapture } from "../history-autocapture";

describe("HistoryAutocapture", () => {
  let capture: HistoryAutocapture | undefined;

  beforeEach(() => {
    history.replaceState(null, "", "/");
  });

  afterEach(() => {
    capture?.stop();
    capture = undefined;
  });

  it("captures on pushState when the pathname changes", () => {
    const onPageview = vi.fn();
    capture = new HistoryAutocapture(onPageview);
    capture.start();

    history.pushState(null, "", "/pricing");
    expect(onPageview).toHaveBeenCalledTimes(1);
  });

  it("captures on replaceState when the pathname changes", () => {
    const onPageview = vi.fn();
    capture = new HistoryAutocapture(onPageview);
    capture.start();

    history.replaceState(null, "", "/docs");
    expect(onPageview).toHaveBeenCalledTimes(1);
  });

  it("ignores query and hash changes", () => {
    const onPageview = vi.fn();
    capture = new HistoryAutocapture(onPageview);
    capture.start();

    history.pushState(null, "", "/?tab=2");
    history.pushState(null, "", "/#section");
    expect(onPageview).not.toHaveBeenCalled();
  });

  it("captures on popstate navigation", () => {
    // Captured before start() so URL changes through it stay invisible to the
    // patch — jsdom has no real history traversal to fire popstate for us
    const silentReplaceState = history.replaceState.bind(history);
    const onPageview = vi.fn();
    capture = new HistoryAutocapture(onPageview);
    capture.start();

    history.pushState(null, "", "/a");
    expect(onPageview).toHaveBeenCalledTimes(1);

    // popstate without a pathname change is ignored
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onPageview).toHaveBeenCalledTimes(1);

    // Simulate the back button: silently restore the old URL, fire popstate
    silentReplaceState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onPageview).toHaveBeenCalledTimes(2);
  });

  it("a stopped instance stays silent even when its wrapper cannot be unpatched", () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const first = new HistoryAutocapture(onFirst);
    const second = new HistoryAutocapture(onSecond);
    first.start();
    second.start(); // second's wrapper now sits on top of first's

    // First can't restore (it isn't top-of-stack); its wrapper must no-op
    first.stop();
    history.pushState(null, "", "/a");
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledTimes(1);

    // After second stops, first's (dead) wrapper is back on top — still silent
    second.stop();
    history.pushState(null, "", "/b");
    expect(onFirst).not.toHaveBeenCalled();
    expect(onSecond).toHaveBeenCalledTimes(1);
  });

  it("stop restores the patched methods", () => {
    const onPageview = vi.fn();
    capture = new HistoryAutocapture(onPageview);
    const original = history.pushState;
    capture.start();
    expect(history.pushState).not.toBe(original);
    capture.stop();
    expect(history.pushState).toBe(original);

    history.pushState(null, "", "/untracked");
    expect(onPageview).not.toHaveBeenCalled();
    capture = undefined;
  });
});
