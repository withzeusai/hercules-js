// The Analytics core, structured after posthog-js posthog-core.ts (heavily
// slimmed): managers own session state, pageview linking, scroll depth, and
// the request pipeline; this class builds wire events and wires everything up.

import { isBlockedUA } from "./blocked-uas";
import {
  DEFAULT_BUFFER_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
  VISITOR_ID_COOKIE,
  VISITOR_ID_COOKIE_DAYS,
} from "./constants";
import { doc, nav, win } from "./globals";
import { HistoryAutocapture } from "./history-autocapture";
import { LIB_VERSION } from "./lib-version";
import { PageViewManager } from "./page-view";
import { request, type Transport } from "./request";
import { RequestQueue } from "./request-queue";
import { RetryQueue } from "./retry-queue";
import type { HerculesEvent } from "./schema";
import { ScrollManager } from "./scroll-manager";
import { SessionIdManager } from "./sessionid";
import type { AnalyticsConfig } from "./types";
import {
  generateId,
  getClickIds,
  getCookie,
  getReferrerInfo,
  getTimezone,
  getUTMParams,
  parseUserAgent,
  setCookie,
} from "./utils";
import { WebVitalsCapture, type WebVitalsMetrics } from "./web-vitals";

export class Analytics {
  private config: Required<AnalyticsConfig>;
  private visitorId: string;
  private userId: string | undefined;
  private readonly isBot: boolean;

  readonly sessionManager: SessionIdManager;
  readonly scrollManager: ScrollManager;
  readonly pageViewManager: PageViewManager;
  private readonly requestQueue: RequestQueue;
  private readonly retryQueue: RetryQueue;
  private webVitals: WebVitalsCapture | undefined;
  private historyAutocapture: HistoryAutocapture | undefined;
  private teardowns: (() => void)[] = [];

  constructor(config: AnalyticsConfig) {
    this.config = {
      apiEndpoint: config.apiEndpoint ?? "https://analytics-ingest.hercules.app",
      debug: config.debug ?? false,
      enabled: config.enabled ?? true,
      bufferSize: config.bufferSize ?? DEFAULT_BUFFER_SIZE,
      flushInterval: config.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS,
      trackPerformance: config.trackPerformance ?? true,
      trackHistoryChanges: config.trackHistoryChanges ?? true,
      cookieDomain: config.cookieDomain ?? "",
      cookiePath: config.cookiePath ?? "/",
      sessionTimeout: config.sessionTimeout ?? DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
    };

    // Bots never produce events (the old client parsed this and ignored it)
    this.isBot = isBlockedUA(nav?.userAgent);

    this.visitorId = this.getOrCreateVisitorId();

    this.scrollManager = new ScrollManager();
    this.pageViewManager = new PageViewManager(this.scrollManager);
    this.sessionManager = new SessionIdManager({
      idleTimeoutMinutes: this.config.sessionTimeout,
      generateId,
    });
    // A rotated session must not link back to the previous session's pageview
    this.sessionManager.onSessionId((_sessionId, changeReason) => {
      if (changeReason) {
        this.pageViewManager.reset();
      }
    });

    this.requestQueue = new RequestQueue(
      this.config.flushInterval,
      this.config.bufferSize,
      (events, transport) => this.send(events, 0, transport),
    );
    this.retryQueue = new RetryQueue((events, retriesPerformedSoFar) =>
      this.send(events, retriesPerformedSoFar),
    );

    if (this.enabled && win && doc) {
      this.scrollManager.startMeasuringScrollPosition();

      if (this.config.trackPerformance) {
        this.webVitals = new WebVitalsCapture((metrics) => this.captureWebVitals(metrics));
      }
      if (this.config.trackHistoryChanges) {
        this.historyAutocapture = new HistoryAutocapture(() => this.trackPageview());
        this.historyAutocapture.start();
      }

      // Pageleave on pagehide (falling back to unload), never beforeunload —
      // see https://calendar.perfplanet.com/2020/beaconing-in-practice/
      const listenerWin = win;
      const listenerDoc = doc;
      const unloadEvent = "onpagehide" in listenerWin ? "pagehide" : "unload";
      const onUnload = () => this.handleUnload();
      listenerWin.addEventListener(unloadEvent, onUnload);
      this.teardowns.push(() => listenerWin.removeEventListener(unloadEvent, onUnload));

      const onVisibilityChange = () => {
        if (listenerDoc.visibilityState === "hidden") {
          this.flush("sendBeacon");
        }
      };
      listenerDoc.addEventListener("visibilitychange", onVisibilityChange);
      this.teardowns.push(() =>
        listenerDoc.removeEventListener("visibilitychange", onVisibilityChange),
      );
    }
  }

  private get enabled(): boolean {
    return this.config.enabled && !this.isBot;
  }

  private getOrCreateVisitorId(): string {
    let visitorId = getCookie(VISITOR_ID_COOKIE);
    if (!visitorId) {
      visitorId = generateId();
      setCookie(
        VISITOR_ID_COOKIE,
        visitorId,
        VISITOR_ID_COOKIE_DAYS,
        this.config.cookieDomain,
        this.config.cookiePath,
      );
    }
    return visitorId;
  }

  private buildEvent(
    eventType: HerculesEvent["event_type"],
    eventName: string,
    properties?: Record<string, any>,
  ): HerculesEvent {
    const { browser, os, deviceType } = parseUserAgent();
    const referrerInfo = getReferrerInfo();
    const utmParams = getUTMParams();
    const clickIds = getClickIds();
    const url = new URL(window.location.href);
    const { sessionId } = this.sessionManager.checkAndGetSessionId();

    const event: HerculesEvent = {
      event_id: generateId(),
      event_type: eventType,
      event_name: eventName,
      timestamp: Date.now(),
      visitor_id: this.visitorId,
      session_id: sessionId,
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
      language: nav?.language,
      timezone: getTimezone(),
      screen_width: win?.screen.width,
      screen_height: win?.screen.height,
      viewport_width: win?.innerWidth,
      viewport_height: win?.innerHeight,
      lib_version: LIB_VERSION,
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

  /** Capture an event and enqueue it for delivery. */
  capture(
    eventType: HerculesEvent["event_type"],
    eventName = "",
    properties?: Record<string, any>,
    wireFields?: Partial<HerculesEvent>,
  ): HerculesEvent | undefined {
    if (!this.enabled || typeof window === "undefined") {
      return undefined;
    }

    const event = this.buildEvent(eventType, eventName, properties);
    if (wireFields) {
      Object.assign(event, wireFields);
    }

    if (eventType === "pageview") {
      Object.assign(event, this.pageViewManager.doPageView(event.timestamp, generateId()));
    } else if (eventType === "pageleave") {
      Object.assign(event, this.pageViewManager.doPageLeave(event.timestamp));
    } else {
      Object.assign(event, this.pageViewManager.doEvent());
    }

    this.requestQueue.enqueue(event);
    return event;
  }

  /**
   * Track a custom event
   */
  track(eventName: string, properties?: Record<string, any>): void {
    this.capture("custom", eventName, properties);
  }

  /**
   * Track a pageview
   */
  trackPageview(properties?: Record<string, any>): void {
    this.capture("pageview", "", properties);
  }

  /**
   * Track a pageleave event and flush immediately
   */
  trackPageleave(): void {
    this.capture("pageleave");
    this.flush("sendBeacon");
  }

  private captureWebVitals(metrics: WebVitalsMetrics): void {
    this.capture("web_vitals", "", undefined, metrics);
  }

  /**
   * Identify the current user
   */
  identify(userId: string): void {
    this.userId = userId;
    this.capture("custom", "identify", { user_id: userId });
  }

  private send(
    events: HerculesEvent[],
    retriesPerformedSoFar: number,
    transport?: Transport,
  ): void {
    if (!this.config.apiEndpoint || !this.enabled) return;

    // sent_at lets the server correct event timestamps for client clock skew
    const body = JSON.stringify({ sent_at: Date.now(), events });

    if (this.config.debug) {
      console.log(`[Hercules Analytics] Sending ${events.length} events`, events);
    }

    request({
      url: this.config.apiEndpoint,
      body,
      transport,
      callback: (response) => {
        const retriable =
          response.statusCode === 0 || response.statusCode >= 500 || response.statusCode === 429;
        if (retriable && transport !== "sendBeacon") {
          this.retryQueue.enqueue(events, retriesPerformedSoFar);
        } else if (this.config.debug && response.statusCode !== 200) {
          console.error(`[Hercules Analytics] Endpoint returned ${response.statusCode}`);
        }
      },
    });
  }

  private handleUnload(): void {
    this.trackPageleave();
    this.requestQueue.unload();
    this.retryQueue.unload((events) => this.send(events, 0, "sendBeacon"));
  }

  /**
   * Flush buffered events now
   */
  flush(transport?: Transport): void {
    this.requestQueue.flush(transport);
  }

  /**
   * Reset visitor-independent state (session, user, pageview linking)
   */
  reset(): void {
    this.sessionManager.reset();
    this.pageViewManager.reset();
    this.userId = undefined;
  }

  /**
   * Tear down listeners and flush what's left
   */
  destroy(): void {
    this.flush();
    this.requestQueue.stop();
    this.retryQueue.stop();
    this.scrollManager.stop();
    this.historyAutocapture?.stop();
    this.webVitals?.stop();
    for (const teardown of this.teardowns) {
      teardown();
    }
    this.teardowns = [];
  }
}
