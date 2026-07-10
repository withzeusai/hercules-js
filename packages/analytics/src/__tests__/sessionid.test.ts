import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_LENGTH_LIMIT_MS, SESSION_STORAGE_KEY } from "../constants";
import { SessionIdManager } from "../sessionid";
import { createMemoryStore } from "../storage";

describe("SessionIdManager", () => {
  let idCounter: number;
  const generateId = () => `session_${++idCounter}`;

  beforeEach(() => {
    idCounter = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createManager(store = createMemoryStore()) {
    return {
      manager: new SessionIdManager({ idleTimeoutMinutes: 30, generateId, store }),
      store,
    };
  }

  it("creates a session on first use", () => {
    const { manager } = createManager();
    const { sessionId, changeReason } = manager.checkAndGetSessionId();
    expect(sessionId).toBe("session_1");
    expect(changeReason?.noSessionId).toBe(true);
  });

  it("keeps the same session across events within the idle timeout", () => {
    const { manager } = createManager();
    const first = manager.checkAndGetSessionId().sessionId;
    vi.advanceTimersByTime(29 * 60 * 1000);
    const second = manager.checkAndGetSessionId();
    expect(second.sessionId).toBe(first);
    expect(second.changeReason).toBeUndefined();
  });

  it("rotates after the idle timeout", () => {
    const { manager } = createManager();
    const first = manager.checkAndGetSessionId().sessionId;
    vi.advanceTimersByTime(31 * 60 * 1000);
    const second = manager.checkAndGetSessionId();
    expect(second.sessionId).not.toBe(first);
    expect(second.changeReason?.activityTimeout).toBe(true);
  });

  it("activity extends the session indefinitely up to the 24h cap", () => {
    const { manager } = createManager();
    const first = manager.checkAndGetSessionId().sessionId;

    // Activity every 20 minutes for 23 hours: never idles out
    for (let i = 0; i < (23 * 60) / 20; i++) {
      vi.advanceTimersByTime(20 * 60 * 1000);
      expect(manager.checkAndGetSessionId().sessionId).toBe(first);
    }

    // ...but the 24-hour maximum still rotates it
    vi.advanceTimersByTime(SESSION_LENGTH_LIMIT_MS);
    const rotated = manager.checkAndGetSessionId();
    expect(rotated.sessionId).not.toBe(first);
    expect(rotated.changeReason?.sessionPastMaximumLength).toBe(true);
  });

  it("readOnly checks do not refresh the activity timestamp", () => {
    const { manager } = createManager();
    const first = manager.checkAndGetSessionId().sessionId;
    // 20 min passes; a readOnly check must not count as activity
    vi.advanceTimersByTime(20 * 60 * 1000);
    manager.checkAndGetSessionId(true);
    // 20 more minutes: 40 min since real activity -> idle rotation
    vi.advanceTimersByTime(20 * 60 * 1000);
    const second = manager.checkAndGetSessionId();
    expect(second.sessionId).not.toBe(first);
    expect(second.changeReason?.activityTimeout).toBe(true);
  });

  it("shares the session across manager instances (cross-tab via storage)", () => {
    const store = createMemoryStore();
    const a = new SessionIdManager({ idleTimeoutMinutes: 30, generateId, store });
    const b = new SessionIdManager({ idleTimeoutMinutes: 30, generateId, store });
    const idA = a.checkAndGetSessionId().sessionId;
    expect(b.checkAndGetSessionId().sessionId).toBe(idA);
  });

  it("notifies subscribers on rotation with the reason", () => {
    const { manager } = createManager();
    const onSession = vi.fn();
    manager.onSessionId(onSession);

    manager.checkAndGetSessionId();
    expect(onSession).toHaveBeenCalledWith(
      "session_1",
      expect.objectContaining({ noSessionId: true }),
    );

    vi.advanceTimersByTime(31 * 60 * 1000);
    manager.checkAndGetSessionId();
    expect(onSession).toHaveBeenCalledWith(
      "session_2",
      expect.objectContaining({ activityTimeout: true }),
    );
  });

  it("reset starts a fresh session on the next event", () => {
    const { manager, store } = createManager();
    const first = manager.checkAndGetSessionId().sessionId;
    manager.reset();
    expect(store.get(SESSION_STORAGE_KEY)).toBeNull();
    const second = manager.checkAndGetSessionId();
    expect(second.sessionId).not.toBe(first);
    expect(second.changeReason?.noSessionId).toBe(true);
  });

  it("adopts a legacy sessionStorage session on upgrade", () => {
    sessionStorage.setItem("_hrc_sid", "legacy_session");
    sessionStorage.setItem("_hrc_last_activity", String(Date.now()));
    const { manager } = createManager();
    expect(manager.checkAndGetSessionId().sessionId).toBe("legacy_session");
    expect(sessionStorage.getItem("_hrc_sid")).toBeNull();
  });
});
