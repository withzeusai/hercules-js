import Bowser from "bowser";
import { ulid } from "ulid";
import type { DeviceInfo, ViewportInfo } from "./types";
import type { DeviceType } from "./schema";

export function generateSessionId(): string {
  return ulid();
}

export function getViewport(): ViewportInfo {
  if (typeof window === "undefined") {
    return { width: 0, height: 0 };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

export function getDeviceInfo(): DeviceInfo {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  let deviceType: DeviceType = "unknown";
  try {
    const parsed = Bowser.parse(ua);
    const platformType = parsed.platform.type;
    if (platformType === "mobile") deviceType = "mobile";
    else if (platformType === "tablet") deviceType = "tablet";
    else if (platformType === "desktop") deviceType = "desktop";
  } catch {
    // best-effort
  }
  return { deviceType, userAgent: ua };
}

const SESSION_STORAGE_KEY = "_hrc_replay_sid";

export function getOrCreatePersistedSessionId(): string {
  if (typeof sessionStorage === "undefined") {
    return generateSessionId();
  }
  const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (existing) return existing;
  const fresh = generateSessionId();
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
  } catch {
    // ignore (Safari private mode etc.)
  }
  return fresh;
}

export function shouldRecord(sampleRate: number | undefined): boolean {
  // Check sample rate against a random number
  if (sampleRate == null) return true;
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;
  return Math.random() * 100 < sampleRate;
}

/**
 * Detects whether the current document is loaded inside an iframe. Used to
 * skip recording in the dashboard preview pane (and other embeds) by
 * default. We compare against `window.top` rather than `window.parent` so
 * that nested iframes are also caught. If the comparison throws (some
 * sandboxed contexts), assume we are framed.
 */
export function isInsideIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

// User agent substrings that identify automation runtimes (headless
// Chromium, Cursor IDE preview, Puppeteer, Playwright, Lighthouse, link
// checkers, generic crawlers). Match is case-insensitive.
const HEADLESS_UA_PATTERN =
  /HeadlessChrome|Headless|Puppeteer|Playwright|Lighthouse|PhantomJS|Selenium|WebDriver|Cypress|Crawler|bot\b|spider|scrapy|curl\/|wget\//i;

/**
 * Detects automated / headless browsers so we don't fill storage with
 * recordings from preview tooling, smoke tests, link previewers and
 * crawlers. Combines the standard `navigator.webdriver` flag with a
 * UA pattern (catches headless Chromium that doesn't always set the
 * flag, e.g. Cursor IDE's bundled browser).
 */
export function isHeadlessBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  if (navigator.webdriver) return true;
  if (HEADLESS_UA_PATTERN.test(navigator.userAgent ?? "")) return true;
  return false;
}
