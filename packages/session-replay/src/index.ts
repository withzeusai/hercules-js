/**
 * @usehercules/session-replay
 * rrweb-based session replay recorder for Hercules applications.
 */

import { record } from "rrweb";
import type { SessionReplayChunk, SessionReplayChunkMeta } from "./schema";

type RrwebEvent = unknown;
import type { SessionReplayConfig, SessionReplayInstance } from "./types";
import {
  getDeviceInfo,
  getOrCreatePersistedSessionId,
  getViewport,
  isHeadlessBrowser,
  isInsideIframe,
} from "./utils";

export type { SessionReplayConfig, SessionReplayInstance } from "./types";
export type { SessionReplayChunk, SessionReplayChunkMeta, DeviceType } from "./schema";

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_CHECKOUT_INTERVAL_MS = 30_000;
const DEFAULT_API_ENDPOINT = "/_hercules/r";

export class SessionReplayRecorder {
  private readonly apiEndpoint: string;
  private readonly userId: string | undefined;
  private readonly debug: boolean;
  private readonly flushIntervalMs: number;
  private readonly checkoutEveryNms: number;
  private readonly maskAllInputs: boolean;
  public readonly sessionId: string;

  private buffer: RrwebEvent[] = [];
  private chunkIndex = 0;
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private stopFn: (() => void) | undefined;
  private chunkStartedAt: number;
  private stopped = false;
  private paused = false;

  constructor(config: SessionReplayConfig) {
    this.apiEndpoint = config.apiEndpoint ?? DEFAULT_API_ENDPOINT;
    this.userId = config.userId;
    this.debug = config.debug ?? false;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.checkoutEveryNms = config.checkoutEveryNms ?? DEFAULT_CHECKOUT_INTERVAL_MS;
    this.maskAllInputs = config.maskAllInputs ?? true;
    this.sessionId = getOrCreatePersistedSessionId();
    this.chunkStartedAt = Date.now();

    if (typeof window === "undefined") {
      if (this.debug) {
        console.warn("[hercules/session-replay] window is not defined; skipping recorder.");
      }
      return;
    }

    // The Hercules dashboard renders the published app in a preview iframe,
    // and we don't want that iframe (or any other embed) to spam recordings
    // while developers are working on the app. Default to top-frame only;
    // callers can opt back in with `recordInIframes: true`.
    if (!(config.recordInIframes ?? false) && isInsideIframe()) {
      this.stopped = true;
      if (this.debug) {
        console.log(
          "[hercules/session-replay] skipped: page is inside an iframe. " +
            "Pass recordInIframes: true to record anyway.",
        );
      }
      return;
    }

    // Skip headless / automation runtimes (Puppeteer, Playwright,
    // Lighthouse, the Cursor IDE preview Chromium, generic bots). These
    // sessions are tooling, not real users, and they often run for hours
    // generating endless animation chunks.
    if (!(config.recordInHeadless ?? false) && isHeadlessBrowser()) {
      this.stopped = true;
      if (this.debug) {
        console.log(
          "[hercules/session-replay] skipped: headless or automated browser detected. " +
            "Pass recordInHeadless: true to record anyway.",
        );
      }
      return;
    }

    // If the page is opened in a background tab we still attach listeners,
    // but we don't start rrweb until it becomes visible. This avoids
    // recording (and uploading) snapshots for tabs the user never sees.
    if (document.visibilityState === "visible") {
      this.startRrweb();
      this.startFlushTimer();
    } else {
      this.paused = true;
    }

    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("pagehide", this.handlePageHide);

    if (this.debug) {
      console.log("[hercules/session-replay] recording started", {
        sessionId: this.sessionId,
        paused: this.paused,
      });
    }
  }

  private startRrweb(): void {
    if (this.stopFn) return;
    const stop = record({
      emit: (event) => {
        this.buffer.push(event);
      },
      checkoutEveryNms: this.checkoutEveryNms,
      maskAllInputs: this.maskAllInputs,
    });
    this.stopFn = stop ?? undefined;
  }

  private stopRrweb(): void {
    this.stopFn?.();
    this.stopFn = undefined;
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private handleVisibilityChange = (): void => {
    if (this.stopped) return;
    if (document.visibilityState === "hidden") {
      this.pauseRecording();
    } else if (document.visibilityState === "visible") {
      this.resumeRecording();
    }
  };

  private handlePageHide = (): void => {
    void this.flush({ isUnload: true });
  };

  /**
   * Stop emitting rrweb events and tear down the flush timer while the
   * tab is in the background. We flush via the unload-safe path because
   * `visibilitychange → hidden` is also what browsers fire when the user
   * is closing the tab — if we used a plain fetch here it would be killed
   * mid-flight by the unload that follows, dropping the last chunk.
   * `flush({ isUnload: true })` uses sendBeacon (or a best-effort plain
   * fetch for oversized bodies) so the request survives teardown.
   */
  private pauseRecording(): void {
    if (this.paused) return;
    this.paused = true;
    void this.flush({ isUnload: true });
    this.stopFlushTimer();
    this.stopRrweb();
    if (this.debug) {
      console.log("[hercules/session-replay] paused (tab hidden)");
    }
  }

  /**
   * Re-attach the rrweb recorder. rrweb will produce a fresh full snapshot
   * as the first event of the next chunk so the player can resume from a
   * clean state.
   */
  private resumeRecording(): void {
    if (!this.paused) return;
    this.paused = false;
    this.chunkStartedAt = Date.now();
    this.startRrweb();
    this.startFlushTimer();
    if (this.debug) {
      console.log("[hercules/session-replay] resumed (tab visible)");
    }
  }

  async flush({ isUnload = false }: { isUnload?: boolean } = {}): Promise<void> {
    if (this.stopped) return;
    if (this.buffer.length === 0) return;

    const events = this.buffer;
    this.buffer = [];
    const startedAt = this.chunkStartedAt;
    const endedAt = Date.now();
    this.chunkStartedAt = endedAt;
    const chunkIndex = this.chunkIndex++;

    const viewport = getViewport();
    const device = getDeviceInfo();

    const meta: SessionReplayChunkMeta = {
      user_agent: device.userAgent,
      viewport_width: viewport.width,
      viewport_height: viewport.height,
      url: typeof window !== "undefined" ? window.location.href : null,
      domain: typeof window !== "undefined" ? window.location.hostname : null,
      device_type: device.deviceType,
      user_id: this.userId ?? null,
    };

    const payload: SessionReplayChunk = {
      session_id: this.sessionId,
      chunk_index: chunkIndex,
      started_at: startedAt,
      ended_at: endedAt,
      events,
      meta,
    };

    const body = JSON.stringify(payload);

    try {
      // Both `sendBeacon` and `fetch({ keepalive: true })` cap the request
      // body at ~64 KB. The first chunk contains a full DOM snapshot which
      // routinely exceeds that. Strategy:
      //   - Unload + small body → sendBeacon (queued by the browser, survives
      //     teardown).
      //   - Unload + large body → plain fetch (best-effort during the
      //     browser's unload grace period; we cannot use keepalive because
      //     it would throw synchronously on oversized bodies).
      //   - Periodic flush (not unloading) → plain fetch, no size limit.
      // Leave a little headroom under the 64 KB cap for browser overhead.
      const KEEPALIVE_MAX_BYTES = 60_000;
      const fitsInBeacon = body.length <= KEEPALIVE_MAX_BYTES;

      const sentViaBeacon =
        isUnload &&
        fitsInBeacon &&
        typeof navigator !== "undefined" &&
        typeof navigator.sendBeacon === "function" &&
        navigator.sendBeacon(this.apiEndpoint, new Blob([body], { type: "application/json" }));

      if (!sentViaBeacon) {
        await fetch(this.apiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: isUnload && fitsInBeacon,
        });
      }

      if (this.debug) {
        console.log("[hercules/session-replay] flushed chunk", {
          chunkIndex,
          eventCount: events.length,
        });
      }
    } catch (error) {
      if (this.debug) {
        console.error("[hercules/session-replay] flush error", error);
      }
      this.buffer.unshift(...events);
      this.chunkIndex = chunkIndex;
      this.chunkStartedAt = startedAt;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopFlushTimer();
    this.stopRrweb();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.handlePageHide);
    }
    await this.flush();
  }
}

let defaultInstance: SessionReplayRecorder | undefined;

function getSessionReplayInstance(config: SessionReplayConfig): SessionReplayRecorder {
  defaultInstance ??= new SessionReplayRecorder(config);
  return defaultInstance;
}

export function initSessionReplay(config: SessionReplayConfig): SessionReplayInstance {
  const instance = getSessionReplayInstance(config);
  return {
    sessionId: instance.sessionId,
    flush: () => instance.flush(),
    stop: () => instance.stop(),
  };
}
