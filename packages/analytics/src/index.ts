/**
 * @usehercules/analytics
 * Web analytics for Hercules applications — a "lite fork" of posthog-js:
 * the module structure and behavioral decisions (session semantics, pageview
 * linking, unload handling, retry backoff) follow upstream, trimmed to the
 * event surface Hercules needs.
 */

import { Analytics } from "./hercules-core";
import type { AnalyticsConfig } from "./types";

export { Analytics };
export { LIB_VERSION } from "./lib-version";
export type {
  AnalyticsConfig,
  BrowserInfo,
  OSInfo,
  PerformanceMetrics,
  ReferrerInfo,
  UTMParams,
} from "./types";
export type { HerculesEvent, AnalyticsPayload } from "./schema";

// Utility re-exports
export {
  generateId,
  getClickIds,
  getCookie,
  getPerformanceMetrics,
  getReferrerInfo,
  getTimezone,
  getUTMParams,
  parseUserAgent,
  setCookie,
} from "./utils";

let defaultInstance: Analytics | null = null;

/**
 * Initialize or get the default analytics instance
 */
export function initAnalytics(config: AnalyticsConfig): Analytics {
  if (!defaultInstance) {
    defaultInstance = new Analytics(config);

    // Auto-track the initial pageview immediately; SPA navigations are
    // captured by history autocapture from here on. Deferring this (the old
    // DOMContentLoaded behavior) double-counted apps that pushState during
    // boot — the history capture fired for the new route and the deferred
    // initial pageview fired again afterwards.
    if (typeof window !== "undefined") {
      defaultInstance.trackPageview();
    }
  }
  return defaultInstance;
}
