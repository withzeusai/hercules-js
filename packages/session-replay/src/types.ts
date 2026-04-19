import type { DeviceType } from "./schema";

export type SessionReplayConfig = {
  /** API endpoint to POST chunks to. Defaults to "/_hercules/r" */
  apiEndpoint?: string;
  /** Sample rate from 0-100. Decides whether the session records at all. Defaults to 100. */
  sampleRate?: number;
  /** Optional end-user identifier to associate the recording with */
  userId?: string;
  /** Enable debug logging to the console */
  debug?: boolean;
  /** How often (ms) to flush a chunk of buffered events. Defaults to 10_000. */
  flushIntervalMs?: number;
  /** rrweb checkout interval — full snapshot interval (ms). Defaults to 30_000. */
  checkoutEveryNms?: number;
  /** Mask all input fields (recommended). Defaults to true. */
  maskAllInputs?: boolean;
  /**
   * Record sessions when the page is loaded inside an iframe (e.g. the
   * Hercules dashboard preview, third-party embeds, OAuth popups).
   * Defaults to `false` so the dashboard's preview iframe doesn't generate
   * spurious recordings while you're working on your app.
   */
  recordInIframes?: boolean;
  /**
   * Record sessions inside headless / automated browsers (Puppeteer,
   * Playwright, Lighthouse, the Cursor IDE preview Chromium, generic bots
   * with `navigator.webdriver`, etc.). Defaults to `false` because these
   * are almost always tooling, not real users.
   */
  recordInHeadless?: boolean;
};

export type SessionReplayInstance = {
  /** Stable session id used to group chunks */
  sessionId: string;
  /** Force-flush any buffered events */
  flush: () => Promise<void>;
  /** Stop recording and flush remaining events */
  stop: () => Promise<void>;
};

export type ViewportInfo = {
  width: number;
  height: number;
};

export type DeviceInfo = {
  deviceType: DeviceType;
  userAgent: string;
};
