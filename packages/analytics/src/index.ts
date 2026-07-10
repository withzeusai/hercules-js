/**
 * @usehercules/analytics
 * Comprehensive analytics library for Hercules applications
 */

import type { HerculesEvent } from "./schema";
import type {
  BrowserInfo,
  OSInfo,
  ReferrerInfo,
  UTMParams,
  PerformanceMetrics,
  AnalyticsConfig,
  AnalyticsProvider,
} from "./types";

import { LIB_VERSION } from "./lib-version";
import {
  generateId,
  getCookie,
  setCookie,
  parseUserAgent,
  getReferrerInfo,
  getUTMParams,
  getClickIds,
  getTimezone,
  getPerformanceMetrics,
  observeWebVitals,
  debounce,
  throttle,
  safeStringify,
  getBrowserInfo,
} from "./utils";

// Re-export types
export type {
  BrowserInfo,
  OSInfo,
  ReferrerInfo,
  UTMParams,
  PerformanceMetrics,
  AnalyticsConfig,
  AnalyticsProvider,
};

// Re-export utils
export {
  generateId,
  getCookie,
  setCookie,
  parseUserAgent,
  getReferrerInfo,
  getUTMParams,
  getClickIds,
  getTimezone,
  getPerformanceMetrics,
  observeWebVitals,
  debounce,
  throttle,
  safeStringify,
  getBrowserInfo,
};
export { LIB_VERSION };

// ============================================================================
// Core Analytics Class
// ============================================================================

export class Analytics {
  private config: Required<AnalyticsConfig>;
  private buffer: HerculesEvent[] = [];
  private providers: AnalyticsProvider[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private visitorId: string;
  private sessionId: string;
  private userId: string | undefined;
  private webVitalsMetrics: PerformanceMetrics = {};
  private currentPageview: { pageviewId: string; pathname: string; timestamp: number } | undefined;
  private scrollContext: { maxScrollY: number; maxScrollHeight: number } | undefined;

  constructor(config: AnalyticsConfig) {
    this.config = {
      apiEndpoint: config.apiEndpoint ?? "https://analytics-ingest.hercules.app",
      debug: config.debug ?? false,
      enabled: config.enabled ?? true,
      bufferSize: config.bufferSize ?? 10,
      flushInterval: config.flushInterval ?? 5000,
      trackClicks: config.trackClicks ?? false,
      trackPerformance: config.trackPerformance ?? true,
      cookieDomain: config.cookieDomain ?? "",
      cookiePath: config.cookiePath ?? "/",
      sessionTimeout: config.sessionTimeout ?? 30,
    };

    // Initialize visitor and session IDs
    this.visitorId = this.getVisitorId();
    this.sessionId = this.getSessionId();

    // Set up auto-flush
    if (this.config.flushInterval > 0) {
      this.startAutoFlush();
    }

    // Set up page visibility listener
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.flush();
        }
      });

      // Set up beforeunload listener
      window.addEventListener("beforeunload", () => {
        this.trackPageleave();
      });
    }

    // Set up scroll depth tracking
    if (typeof window !== "undefined") {
      this.setupScrollTracking();
    }

    // Set up click tracking
    if (this.config.trackClicks && typeof document !== "undefined") {
      this.setupClickTracking();
    }

    // Set up Web Vitals observation
    if (this.config.trackPerformance) {
      this.setupWebVitals();
    }
  }

  /**
   * Get or create visitor ID (stored in cookie)
   */
  private getVisitorId(): string {
    let visitorId = getCookie("_hrc_vid");
    if (!visitorId) {
      visitorId = generateId();
      setCookie("_hrc_vid", visitorId, 365 * 2, this.config.cookieDomain, this.config.cookiePath);
    }
    return visitorId;
  }

  /**
   * Get or create session ID (stored in session storage)
   */
  private getSessionId(): string {
    if (typeof sessionStorage === "undefined") {
      return generateId();
    }

    let sessionId = sessionStorage.getItem("_hrc_sid");
    const lastActivity = sessionStorage.getItem("_hrc_last_activity");
    const now = Date.now();

    // Check if session has expired
    if (sessionId && lastActivity) {
      const timeSinceLastActivity = now - parseInt(lastActivity, 10);
      if (timeSinceLastActivity > this.config.sessionTimeout * 60 * 1000) {
        sessionId = null;
      }
    }

    if (!sessionId) {
      sessionId = generateId();
      sessionStorage.setItem("_hrc_sid", sessionId);
    }

    sessionStorage.setItem("_hrc_last_activity", now.toString());
    return sessionId;
  }

  /**
   * Create an event object
   */
  private createEvent(
    eventType: HerculesEvent["event_type"],
    eventName = "",
    properties?: Record<string, any>,
  ): HerculesEvent {
    const { browser, os, deviceType } = parseUserAgent();
    const referrerInfo = getReferrerInfo();
    const utmParams = getUTMParams();
    const clickIds = getClickIds();
    const url = new URL(window.location.href);

    const event: HerculesEvent = {
      event_id: generateId(),
      event_type: eventType,
      event_name: eventName,
      timestamp: Date.now(),
      visitor_id: this.visitorId,
      session_id: this.sessionId,
      ...(this.userId && { user_id: this.userId }),
      origin: url.origin,
      url: url.href,
      url_path: url.pathname,
      url_query: url.search.substring(1),
      url_hash: url.hash.substring(1),
      referrer: referrerInfo.referrer,
      referrer_domain: referrerInfo.referrer_domain,
      referrer_source: referrerInfo.referrer_source,
      browser: browser.name,
      browser_version: browser.version,
      os: os.name,
      os_version: os.version,
      device_type: deviceType,
      language: navigator.language,
      timezone: getTimezone(),
      screen_width: window.screen.width,
      screen_height: window.screen.height,
      viewport_width: window.innerWidth,
      viewport_height: window.innerHeight,
      lib_version: LIB_VERSION,
      ...(this.currentPageview && { pageview_id: this.currentPageview.pageviewId }),
      utm_source: utmParams.utm_source,
      utm_medium: utmParams.utm_medium,
      utm_campaign: utmParams.utm_campaign,
      utm_content: utmParams.utm_content,
      utm_term: utmParams.utm_term,
      properties: { ...clickIds },
      properties_numeric: {},
    };

    for (const [key, value] of Object.entries(properties || {})) {
      if (typeof value === "number") {
        event.properties_numeric![key] = value;
      } else {
        event.properties![key] = value;
      }
    }

    return event;
  }

  /**
   * Track how far down the page the visitor scrolls. Uses a capturing listener
   * like posthog-js so scrolls inside nested containers still update the context.
   */
  private setupScrollTracking(): void {
    window.addEventListener(
      "scroll",
      () => {
        const context = (this.scrollContext ??= { maxScrollY: 0, maxScrollHeight: 0 });
        context.maxScrollY = Math.max(context.maxScrollY, window.scrollY);
        context.maxScrollHeight = Math.max(
          context.maxScrollHeight,
          document.documentElement.scrollHeight - window.innerHeight,
        );
      },
      { capture: true, passive: true },
    );
  }

  private resetScrollContext(): void {
    if (typeof window === "undefined") {
      this.scrollContext = undefined;
      return;
    }
    this.scrollContext = {
      maxScrollY: window.scrollY,
      maxScrollHeight: document.documentElement.scrollHeight - window.innerHeight,
    };
  }

  /**
   * Properties linking an event to the previous pageview (posthog-style
   * $prev_pageview_*). On a pageview, `pageviewId` is the new pageview's id and
   * prev_* describes the page being left; on a pageleave, `pageviewId` is the
   * current pageview's id and prev_* describes that same (ending) pageview.
   */
  private prevPageviewProperties(
    timestamp: number,
    pageviewId: string | undefined,
  ): Partial<HerculesEvent> {
    const previous = this.currentPageview;
    const properties: Partial<HerculesEvent> = { pageview_id: pageviewId };

    if (!previous) {
      return properties;
    }

    properties.prev_pageview_id = previous.pageviewId;
    properties.prev_pageview_pathname = previous.pathname;
    properties.prev_pageview_duration = (timestamp - previous.timestamp) / 1000;

    if (this.scrollContext) {
      const maxScrollHeight = Math.ceil(this.scrollContext.maxScrollHeight);
      const maxScrollY = Math.ceil(this.scrollContext.maxScrollY);
      // A page that doesn't scroll counts as fully scrolled, matching posthog-js
      properties.prev_pageview_max_scroll_percentage =
        maxScrollHeight <= 1 ? 1 : Math.min(1, Math.max(0, maxScrollY / maxScrollHeight));
    }

    return properties;
  }

  /**
   * Set up click tracking
   */
  private setupClickTracking(): void {
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();

      if (tagName === "a" || tagName === "button" || target.getAttribute("data-track-click")) {
        const properties: Record<string, any> = {
          element: tagName,
          text: target.textContent?.substring(0, 100) || "",
          class: target.className || "",
          id: target.id || "",
        };

        if (tagName === "a") {
          properties.href = (target as HTMLAnchorElement).href || "";
        }

        this.track("click", properties);
      }
    });
  }

  /**
   * Send events to the endpoint
   */
  private async sendToEndpoint(events: HerculesEvent[]): Promise<void> {
    if (!this.config.apiEndpoint || !this.config.enabled) return;

    // sent_at lets the server correct event timestamps for client clock skew
    const payload = { sent_at: Date.now(), events };
    const jsonString = JSON.stringify(payload);

    if (this.config.debug) {
      console.log("[Hercules Analytics] Sending events:", payload);
    }

    // Use sendBeacon if available for better reliability
    if (navigator.sendBeacon) {
      const blob = new Blob([jsonString], { type: "application/json" });

      const sent = navigator.sendBeacon(this.config.apiEndpoint, blob);
      if (!sent) {
        throw new Error("sendBeacon failed");
      }
    } else {
      // Fallback to fetch
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      const response = await fetch(this.config.apiEndpoint, {
        method: "POST",
        headers,
        body: jsonString,
        keepalive: true,
      });

      if (!response.ok) {
        throw new Error(`Analytics endpoint returned ${response.status}`);
      }
    }
  }

  /**
   * Start automatic flush interval
   */
  private startAutoFlush(): void {
    this.stopAutoFlush();
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }

  /**
   * Stop automatic flush interval
   */
  private stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * Track a custom event
   */
  track(eventName: string, properties?: Record<string, any>): void {
    if (!this.config.enabled) return;

    const event = this.createEvent("custom", eventName, properties);
    this.buffer.push(event);

    if (this.buffer.length >= this.config.bufferSize) {
      this.flush();
    }
  }

  /**
   * Set up Web Vitals collection
   */
  private setupWebVitals(): void {
    let webVitalsEventSent = false;
    let webVitalsTimeout: ReturnType<typeof setTimeout> | undefined;

    observeWebVitals((metrics) => {
      this.webVitalsMetrics = { ...this.webVitalsMetrics, ...metrics };

      // Clear any existing timeout
      if (webVitalsTimeout) {
        clearTimeout(webVitalsTimeout);
      }

      // Check if we have enough critical metrics to send the event
      const hasCriticalMetrics =
        (this.webVitalsMetrics.largest_contentful_paint !== undefined ||
          this.webVitalsMetrics.first_contentful_paint !== undefined) &&
        this.webVitalsMetrics.cumulative_layout_shift !== undefined;

      if (hasCriticalMetrics && !webVitalsEventSent) {
        // Wait a bit more for additional metrics, then send
        webVitalsTimeout = setTimeout(() => {
          this.trackWebVitals();
          webVitalsEventSent = true;
        }, 500); // Small delay to collect more metrics if available
      }
    });

    // Fallback: Send web vitals after 5 seconds if we have any metrics
    setTimeout(() => {
      if (!webVitalsEventSent) {
        this.trackWebVitals();
        webVitalsEventSent = true;
      }
    }, 5000);
  }

  /**
   * Track a pageview
   */
  trackPageview(properties?: Record<string, any>): void {
    if (!this.config.enabled) return;

    const event = this.createEvent("pageview", "", properties);

    const pageviewId = generateId();
    Object.assign(event, this.prevPageviewProperties(event.timestamp, pageviewId));
    this.currentPageview = {
      pageviewId,
      pathname: event.url_path,
      timestamp: event.timestamp,
    };
    this.resetScrollContext();

    this.buffer.push(event);

    if (this.buffer.length >= this.config.bufferSize) {
      this.flush();
    }
  }

  /**
   * Track web vitals as a separate event
   */
  private trackWebVitals(): void {
    if (!this.config.enabled || !this.config.trackPerformance) return;

    // Only track if we have meaningful web vitals data
    const hasVitals =
      this.webVitalsMetrics.first_contentful_paint !== undefined ||
      this.webVitalsMetrics.largest_contentful_paint !== undefined ||
      this.webVitalsMetrics.cumulative_layout_shift !== undefined ||
      this.webVitalsMetrics.interaction_to_next_paint !== undefined;

    if (!hasVitals) return;

    const event = this.createEvent("web_vitals", "");

    // Map web vitals metrics to abbreviated field names matching the schema
    if (this.webVitalsMetrics.first_contentful_paint !== undefined) {
      event.fcp = this.webVitalsMetrics.first_contentful_paint;
    }
    if (this.webVitalsMetrics.largest_contentful_paint !== undefined) {
      event.lcp = this.webVitalsMetrics.largest_contentful_paint;
    }
    if (this.webVitalsMetrics.cumulative_layout_shift !== undefined) {
      event.cls = this.webVitalsMetrics.cumulative_layout_shift;
    }
    if (this.webVitalsMetrics.interaction_to_next_paint !== undefined) {
      event.inp = this.webVitalsMetrics.interaction_to_next_paint;
    }
    if (this.webVitalsMetrics.time_to_first_byte !== undefined) {
      event.ttfb = this.webVitalsMetrics.time_to_first_byte;
    }
    if (this.webVitalsMetrics.page_load_time !== undefined) {
      event.plt = this.webVitalsMetrics.page_load_time;
    }
    if (this.webVitalsMetrics.dom_interactive !== undefined) {
      event.di = this.webVitalsMetrics.dom_interactive;
    }

    this.buffer.push(event);

    if (this.buffer.length >= this.config.bufferSize) {
      this.flush();
    }
  }

  /**
   * Track a pageleave event
   */
  trackPageleave(): void {
    if (!this.config.enabled) return;

    const event = this.createEvent("pageleave", "");
    Object.assign(
      event,
      this.prevPageviewProperties(event.timestamp, this.currentPageview?.pageviewId),
    );
    this.buffer.push(event);
    this.flush(); // Always flush immediately on page leave
  }

  /**
   * Add a provider
   */
  addProvider(provider: AnalyticsProvider): void {
    this.providers.push(provider);
    if (this.config.debug) {
      console.log(`[Hercules Analytics] Provider '${provider.name}' added`);
    }
  }

  /**
   * Remove a provider
   */
  removeProvider(name: string): void {
    this.providers = this.providers.filter((p) => p.name !== name);
  }

  /**
   * Flush the event buffer
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const events = [...this.buffer];
    this.buffer = [];

    try {
      // Send to all providers
      await Promise.all([
        // Send to providers
        ...this.providers.map((provider) =>
          provider.send(events).catch((err) => {
            if (this.config.debug) {
              console.error(`[Hercules Analytics] Provider '${provider.name}' error:`, err);
            }
          }),
        ),
        // Send to default endpoint
        this.sendToEndpoint(events).catch((err) => {
          if (this.config.debug) {
            console.error("[Hercules Analytics] Endpoint error:", err);
          }
        }),
      ]);

      if (this.config.debug) {
        console.log(`[Hercules Analytics] Flushed ${events.length} events`);
      }
    } catch (error) {
      if (this.config.debug) {
        console.error("[Hercules Analytics] Flush error:", error);
      }
      // Re-add events to buffer on failure
      this.buffer.unshift(...events);
    }
  }

  /**
   * Identify the current user
   */
  identify(userId: string): void {
    this.userId = userId;
    // Optionally track an identify event
    if (this.config.enabled) {
      const event = this.createEvent("custom", "identify", { user_id: userId });
      this.buffer.push(event);
      if (this.buffer.length >= this.config.bufferSize) {
        this.flush();
      }
    }
  }

  /**
   * Reset the analytics instance
   */
  reset(): void {
    this.buffer = [];
    this.sessionId = this.getSessionId();
    this.userId = undefined;
    this.webVitalsMetrics = {};
    this.currentPageview = undefined;
    this.resetScrollContext();
  }

  /**
   * Destroy the analytics instance
   */
  destroy(): void {
    this.stopAutoFlush();
    this.flush();
    this.providers = [];
    this.buffer = [];
  }
}

// ============================================================================
// Providers
// ============================================================================

/**
 * Console provider for debugging
 */
export class ConsoleProvider implements AnalyticsProvider {
  name = "console";

  async send(events: HerculesEvent[]): Promise<void> {
    events.forEach((event) => {
      console.log("[ConsoleProvider]", event);
    });
  }
}

// ============================================================================
// Singleton and Helper Functions
// ============================================================================

let defaultInstance: Analytics | null = null;

/**
 * Initialize or get the default analytics instance
 */
export function initAnalytics(config: AnalyticsConfig): Analytics {
  if (!defaultInstance) {
    defaultInstance = new Analytics(config);

    // Auto-track pageview on initialization - immediately
    if (typeof window !== "undefined") {
      // Track pageview immediately, don't wait for web vitals
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          defaultInstance?.trackPageview();
        });
      } else {
        // DOM is already loaded, track immediately
        defaultInstance?.trackPageview();
      }
    }
  }
  return defaultInstance;
}
