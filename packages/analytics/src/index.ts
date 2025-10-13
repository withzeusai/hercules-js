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
  CompressionConfig,
} from "./types";

import {
  generateId,
  getCookie,
  setCookie,
  parseUserAgent,
  getReferrerInfo,
  getUTMParams,
  getPerformanceMetrics,
  observeWebVitals,
  debounce,
  throttle,
  safeStringify,
  getBrowserInfo,
  isDoNotTrackEnabled,
  compressData,
  shouldCompress,
  isCompressionSupported,
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
  CompressionConfig,
};

// Re-export utils
export {
  generateId,
  getCookie,
  setCookie,
  parseUserAgent,
  getReferrerInfo,
  getUTMParams,
  getPerformanceMetrics,
  observeWebVitals,
  debounce,
  throttle,
  safeStringify,
  getBrowserInfo,
  isDoNotTrackEnabled,
  compressData,
  shouldCompress,
  isCompressionSupported,
};

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
  private userId?: string;
  private webVitalsMetrics: PerformanceMetrics = {};

  constructor(config: AnalyticsConfig) {
    this.config = {
      apiEndpoint: config.apiEndpoint || "",
      organizationId: config.organizationId,
      websiteId: config.websiteId,
      debug: config.debug ?? false,
      enabled: config.enabled ?? true,
      bufferSize: config.bufferSize ?? 10,
      flushInterval: config.flushInterval ?? 5000,
      trackClicks: config.trackClicks ?? false,
      trackPerformance: config.trackPerformance ?? true,
      cookieDomain: config.cookieDomain ?? "",
      cookiePath: config.cookiePath ?? "/",
      sessionTimeout: config.sessionTimeout ?? 30,
      compression: {
        enabled: config.compression?.enabled ?? true,
        threshold: config.compression?.threshold ?? 1024,
        format: config.compression?.format ?? "gzip",
        fallbackToUncompressed:
          config.compression?.fallbackToUncompressed ?? true,
      },
      beforeSend: config.beforeSend ?? ((e) => e),
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
      setCookie(
        "_hrc_vid",
        visitorId,
        365 * 2,
        this.config.cookieDomain,
        this.config.cookiePath,
      );
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
    const { browser, os } = parseUserAgent();
    const referrerInfo = getReferrerInfo();
    const utmParams = getUTMParams();
    const url = new URL(window.location.href);

    const event: HerculesEvent = {
      event_id: generateId(),
      event_type: eventType,
      event_name: eventName,
      organization_id: this.config.organizationId,
      website_id: this.config.websiteId,
      timestamp: Date.now(),
      visitor_id: this.visitorId,
      session_id: this.sessionId,
      ...(this.userId && { user_id: this.userId }),
      origin: url.origin,
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
      utm_source: utmParams.utm_source,
      utm_medium: utmParams.utm_medium,
      utm_campaign: utmParams.utm_campaign,
      utm_content: utmParams.utm_content,
      utm_term: utmParams.utm_term,
      properties: {},
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
   * Set up click tracking
   */
  private setupClickTracking(): void {
    document.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();

      if (
        tagName === "a" ||
        tagName === "button" ||
        target.getAttribute("data-track-click")
      ) {
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

    const payload = { events };
    const jsonString = JSON.stringify(payload);

    if (this.config.debug) {
      console.log("[Hercules Analytics] Sending events:", payload);
    }

    // Determine if we should compress
    const compressionConfig = this.config.compression!;
    const shouldUseCompression =
      compressionConfig.enabled &&
      shouldCompress(jsonString, compressionConfig.threshold);

    let bodyToSend: Blob | string | Uint8Array = jsonString;
    let contentType = "application/json";
    let contentEncoding: string | undefined;

    // Try to compress if conditions are met
    if (shouldUseCompression) {
      const compressed = await compressData(
        jsonString,
        compressionConfig.format,
      );

      if (compressed) {
        bodyToSend = compressed;
        contentType = "application/octet-stream";
        contentEncoding = compressionConfig.format;

        if (this.config.debug) {
          const ratio = (
            (1 - compressed.length / jsonString.length) *
            100
          ).toFixed(1);
          console.log(
            `[Hercules Analytics] Compressed ${jsonString.length} bytes → ${compressed.length} bytes (${ratio}% reduction)`,
          );
        }
      } else if (!compressionConfig.fallbackToUncompressed) {
        // Compression failed and fallback disabled
        throw new Error("Compression failed and fallback is disabled");
      } else if (this.config.debug) {
        console.log(
          "[Hercules Analytics] Compression not available, sending uncompressed",
        );
      }
    }

    // Use sendBeacon if available for better reliability
    if (navigator.sendBeacon) {
      const blob =
        bodyToSend instanceof Uint8Array
          ? new Blob(
              [
                bodyToSend.buffer.slice(
                  bodyToSend.byteOffset,
                  bodyToSend.byteOffset + bodyToSend.byteLength,
                ) as ArrayBuffer,
              ],
              { type: contentType },
            )
          : new Blob([bodyToSend as string], { type: "application/json" });

      const sent = navigator.sendBeacon(this.config.apiEndpoint, blob);
      if (!sent) {
        throw new Error("sendBeacon failed");
      }
    } else {
      // Fallback to fetch
      const headers: Record<string, string> = {
        "Content-Type": contentType,
      };

      if (contentEncoding) {
        headers["Content-Encoding"] = contentEncoding;
        headers["X-Original-Size"] = jsonString.length.toString();
      }

      const response = await fetch(this.config.apiEndpoint, {
        method: "POST",
        headers,
        body: bodyToSend as BodyInit,
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

    // Add immediate performance metrics (not web vitals)
    if (this.config.trackPerformance) {
      const perfMetrics = getPerformanceMetrics();
      // Only include basic performance metrics in pageview (using abbreviated field names)
      if (perfMetrics.page_load_time !== undefined) {
        event.plt = perfMetrics.page_load_time;
      }
      if (perfMetrics.dom_interactive !== undefined) {
        event.di = perfMetrics.dom_interactive;
      }
      if (perfMetrics.time_to_first_byte !== undefined) {
        event.ttfb = perfMetrics.time_to_first_byte;
      }
    }

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
      this.webVitalsMetrics.first_input_delay !== undefined ||
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
    if (this.webVitalsMetrics.first_input_delay !== undefined) {
      event.fid = this.webVitalsMetrics.first_input_delay;
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
      const processedEvents = await this.config.beforeSend(events);

      // Send to all providers
      await Promise.all([
        // Send to providers
        ...this.providers.map((provider) =>
          provider.send(processedEvents).catch((err) => {
            if (this.config.debug) {
              console.error(
                `[Hercules Analytics] Provider '${provider.name}' error:`,
                err,
              );
            }
          }),
        ),
        // Send to default endpoint
        this.sendToEndpoint(processedEvents).catch((err) => {
          if (this.config.debug) {
            console.error("[Hercules Analytics] Endpoint error:", err);
          }
        }),
      ]);

      if (this.config.debug) {
        console.log(
          `[Hercules Analytics] Flushed ${processedEvents.length} events`,
        );
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
    delete this.userId;
    this.webVitalsMetrics = {};
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

/**
 * Local storage provider
 */
export class LocalStorageProvider implements AnalyticsProvider {
  name = "localStorage";
  private readonly key: string;
  private readonly maxEvents: number;

  constructor(key = "hercules_analytics_events", maxEvents = 100) {
    this.key = key;
    this.maxEvents = maxEvents;
  }

  async send(events: HerculesEvent[]): Promise<void> {
    if (typeof localStorage === "undefined") return;

    try {
      const stored = localStorage.getItem(this.key);
      const existingEvents: HerculesEvent[] = stored ? JSON.parse(stored) : [];
      const allEvents = [...existingEvents, ...events];

      // Keep only the most recent events
      const eventsToStore = allEvents.slice(-this.maxEvents);
      localStorage.setItem(this.key, JSON.stringify(eventsToStore));
    } catch (error) {
      console.error("[LocalStorageProvider] Error storing events:", error);
    }
  }

  getEvents(): HerculesEvent[] {
    if (typeof localStorage === "undefined") return [];

    try {
      const stored = localStorage.getItem(this.key);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  clear(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(this.key);
    }
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

/**
 * Get the current analytics instance
 */
export function getAnalytics(): Analytics | null {
  return defaultInstance;
}

/**
 * Track a custom event
 */
export const track = (
  eventName: string,
  properties?: Record<string, any>,
): void => {
  if (!defaultInstance) {
    console.warn(
      "[Hercules Analytics] Not initialized. Call initAnalytics() first.",
    );
    return;
  }
  defaultInstance.track(eventName, properties);
};

/**
 * Track a pageview
 */
export const trackPageview = (properties?: Record<string, any>): void => {
  if (!defaultInstance) {
    console.warn(
      "[Hercules Analytics] Not initialized. Call initAnalytics() first.",
    );
    return;
  }
  defaultInstance.trackPageview(properties);
};

/**
 * Identify a user
 */
export const identify = (userId: string): void => {
  if (!defaultInstance) {
    console.warn(
      "[Hercules Analytics] Not initialized. Call initAnalytics() first.",
    );
    return;
  }
  defaultInstance.identify(userId);
};

// Export default
export default Analytics;
