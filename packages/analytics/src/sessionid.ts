// Session management adapted from posthog-js sessionid.ts: a session rotates
// after 30 minutes of inactivity (configurable) or 24 hours of total length,
// activity is refreshed on every captured event, and state persists in
// localStorage so one session spans tabs. IDs are ULIDs (time-sortable), not
// posthog's UUIDv7.

import {
  LEGACY_LAST_ACTIVITY_KEY,
  LEGACY_SESSION_ID_KEY,
  SESSION_LENGTH_LIMIT_MS,
  SESSION_STORAGE_KEY,
} from "./constants";
import { pickSessionStore, sessionStore, type PersistentStore } from "./storage";

export interface SessionIdChangeReason {
  noSessionId: boolean;
  activityTimeout: boolean;
  sessionPastMaximumLength: boolean;
}

export type SessionIdChangedCallback = (
  sessionId: string,
  changeReason: SessionIdChangeReason | undefined,
) => void;

interface SessionState {
  sessionId: string | null;
  lastActivityTimestamp: number;
  sessionStartTimestamp: number;
}

export interface SessionIdManagerOptions {
  idleTimeoutMinutes: number;
  generateId: () => string;
  /** Injectable for tests; defaults to localStorage with memory fallback */
  store?: PersistentStore;
}

export class SessionIdManager {
  private readonly idleTimeoutMs: number;
  private readonly generateId: () => string;
  private readonly store: PersistentStore;
  private callbacks: SessionIdChangedCallback[] = [];
  private lastKnownSessionId: string | null = null;

  constructor(options: SessionIdManagerOptions) {
    this.idleTimeoutMs = options.idleTimeoutMinutes * 60 * 1000;
    this.generateId = options.generateId;
    this.store = options.store ?? pickSessionStore();
    this.migrateLegacySession();
  }

  /**
   * @usehercules/analytics < 2.0 kept the session id in sessionStorage. Adopt
   * it once so upgrading doesn't split an in-flight session.
   */
  private migrateLegacySession(): void {
    if (this.store.get(SESSION_STORAGE_KEY) !== null) {
      return;
    }
    const legacyId = sessionStore.get(LEGACY_SESSION_ID_KEY);
    if (!legacyId) {
      return;
    }
    const legacyActivity = Number(sessionStore.get(LEGACY_LAST_ACTIVITY_KEY));
    const activity = Number.isFinite(legacyActivity) && legacyActivity > 0 ? legacyActivity : 0;
    this.persist({
      sessionId: legacyId,
      lastActivityTimestamp: activity,
      // The legacy format never tracked a start timestamp; the best available
      // lower bound is the last activity.
      sessionStartTimestamp: activity,
    });
    sessionStore.remove(LEGACY_SESSION_ID_KEY);
    sessionStore.remove(LEGACY_LAST_ACTIVITY_KEY);
  }

  private load(): SessionState {
    const raw = this.store.get(SESSION_STORAGE_KEY);
    if (raw) {
      try {
        const [sessionId, lastActivityTimestamp, sessionStartTimestamp] = JSON.parse(raw) as [
          string | null,
          number,
          number,
        ];
        return {
          sessionId: typeof sessionId === "string" ? sessionId : null,
          lastActivityTimestamp:
            typeof lastActivityTimestamp === "number" ? lastActivityTimestamp : 0,
          sessionStartTimestamp:
            typeof sessionStartTimestamp === "number" ? sessionStartTimestamp : 0,
        };
      } catch {
        // fall through to a fresh state
      }
    }
    return { sessionId: null, lastActivityTimestamp: 0, sessionStartTimestamp: 0 };
  }

  private persist(state: SessionState): void {
    this.store.set(
      SESSION_STORAGE_KEY,
      JSON.stringify([state.sessionId, state.lastActivityTimestamp, state.sessionStartTimestamp]),
    );
  }

  /** Subscribe to session id changes; returns an unsubscribe function. */
  onSessionId(callback: SessionIdChangedCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((cb) => cb !== callback);
    };
  }

  /**
   * Returns the current session id, rotating it first when there is none,
   * the session idled out, or it exceeded the 24h maximum. Refreshes the
   * activity timestamp unless `readOnly` is set.
   *
   * Reads persisted state on every call so a rotation done by another tab is
   * adopted rather than raced.
   */
  checkAndGetSessionId(readOnly = false): {
    sessionId: string;
    sessionStartTimestamp: number;
    changeReason: SessionIdChangeReason | undefined;
  } {
    const now = Date.now();
    const state = this.load();

    const noSessionId = !state.sessionId;
    const activityTimeout =
      !noSessionId &&
      state.lastActivityTimestamp > 0 &&
      now - state.lastActivityTimestamp > this.idleTimeoutMs;
    const sessionPastMaximumLength =
      !noSessionId &&
      state.sessionStartTimestamp > 0 &&
      now - state.sessionStartTimestamp > SESSION_LENGTH_LIMIT_MS;

    let changeReason: SessionIdChangeReason | undefined;
    let sessionId = state.sessionId;
    let sessionStartTimestamp = state.sessionStartTimestamp;

    if (noSessionId || activityTimeout || sessionPastMaximumLength) {
      sessionId = this.generateId();
      sessionStartTimestamp = now;
      changeReason = { noSessionId, activityTimeout, sessionPastMaximumLength };
    }

    const lastActivityTimestamp = readOnly ? state.lastActivityTimestamp : now;
    this.persist({ sessionId, lastActivityTimestamp, sessionStartTimestamp });

    // Notify on rotation — including one performed by another tab, which shows
    // up here as a changed id without a local changeReason.
    const rotatedElsewhere =
      !changeReason && this.lastKnownSessionId !== null && sessionId !== this.lastKnownSessionId;
    if (changeReason || rotatedElsewhere) {
      const reason = changeReason ?? {
        noSessionId: false,
        activityTimeout: false,
        sessionPastMaximumLength: false,
      };
      for (const callback of this.callbacks) {
        callback(sessionId as string, reason);
      }
    }
    this.lastKnownSessionId = sessionId;

    return { sessionId: sessionId as string, sessionStartTimestamp, changeReason };
  }

  /** Drop the current session; the next event starts a fresh one. */
  reset(): void {
    this.store.remove(SESSION_STORAGE_KEY);
    this.lastKnownSessionId = null;
  }
}
