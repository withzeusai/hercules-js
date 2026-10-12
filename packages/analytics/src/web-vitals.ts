// Web vitals capture with posthog-js extensions/web-vitals semantics. Unlike
// posthog (which lazy-loads the collector from its CDN) the web-vitals library
// is statically bundled — the artifact must stay self-contained.
//
// Metrics buffer as they arrive and flush as a single event. LCP, CLS, and INP
// only settle when the page is hidden, so the flush is driven by that page-hide
// signal — flushNow(), called from the core's pagehide/visibilitychange
// handlers — rather than a timer that would lock in partial values first. On
// browsers without PerformanceObserver no web-vitals callback ever fires, so a
// short timer flushes the Navigation Timing metrics (plt/di/ttfb) on their own.

import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import { WEB_VITALS_FLUSH_MS, WEB_VITALS_MAX_VALUE_MS } from "./constants";
import { doc, win } from "./globals";
import { getPerformanceMetrics } from "./utils";

/** Abbreviated wire-format field names, see schema.ts */
export interface WebVitalsMetrics {
  fcp?: number;
  lcp?: number;
  cls?: number;
  inp?: number;
  ttfb?: number;
  plt?: number;
  di?: number;
}

export class WebVitalsCapture {
  private buffer: WebVitalsMetrics = {};
  private flushTimeout: ReturnType<typeof setTimeout> | undefined;
  private flushed = false;

  constructor(private readonly onFlush: (metrics: WebVitalsMetrics) => void) {
    if (!win || !doc) {
      return;
    }
    if (typeof PerformanceObserver === "undefined") {
      // No web vitals available, but Navigation Timing metrics (plt/di/ttfb)
      // still are — arm the flush so they aren't lost on such browsers
      this.flushTimeout = setTimeout(() => this.flush(), WEB_VITALS_FLUSH_MS);
      return;
    }
    const buffered = (key: keyof WebVitalsMetrics) => (metric: Metric) => {
      // Drop implausible timing values (bfcache restores, clock skew). CLS is a
      // small unitless decimal so this never trips it.
      if (key !== "cls" && metric.value >= WEB_VITALS_MAX_VALUE_MS) {
        return;
      }
      // CLS is a small decimal; everything else is whole milliseconds
      this.addMetric(
        key,
        key === "cls" ? Math.round(metric.value * 1000) / 1000 : Math.round(metric.value),
      );
    };
    onCLS(buffered("cls"), { reportAllChanges: false });
    onFCP(buffered("fcp"));
    onLCP(buffered("lcp"), { reportAllChanges: false });
    onTTFB(buffered("ttfb"));
    onINP(buffered("inp"), { reportAllChanges: false });
  }

  private addMetric(key: keyof WebVitalsMetrics, value: number): void {
    if (this.flushed) {
      return;
    }
    // Don't arm a timer here: LCP/CLS/INP report their terminal values as the
    // page hides, and flushNow() (wired to pagehide/visibilitychange) sends the
    // buffer then. Flushing on a timer would lock in FCP/TTFB and drop the
    // Core Web Vitals that arrive later.
    this.buffer[key] = value;
  }

  /**
   * Flush whatever has been collected right now, instead of waiting out the
   * timer. Called when the page is hidden/unloading: web-vitals delivers the
   * terminal LCP/CLS/INP values at exactly that moment, and a bounce shorter
   * than the flush timer would otherwise send no web_vitals event at all.
   */
  flushNow(): void {
    this.flush();
  }

  private flush(): void {
    if (this.flushed) {
      return;
    }
    this.flushed = true;

    // Fold in navigation-timing metrics; they also backfill ttfb/fcp when the
    // web-vitals callbacks never reported (or never ran). Apply the same
    // implausible-value cap as the callback path — a prerender/bfcache/clock-skew
    // navigation can put responseStart & friends past 15 min, and this fallback
    // would otherwise ship those garbage values for the same wire fields.
    const navigationMetrics = getPerformanceMetrics();
    const plausible = (value: number | undefined): value is number =>
      value !== undefined && value < WEB_VITALS_MAX_VALUE_MS;
    if (plausible(navigationMetrics.page_load_time)) {
      this.buffer.plt = navigationMetrics.page_load_time;
    }
    if (plausible(navigationMetrics.dom_interactive)) {
      this.buffer.di = navigationMetrics.dom_interactive;
    }
    if (this.buffer.ttfb === undefined && plausible(navigationMetrics.time_to_first_byte)) {
      this.buffer.ttfb = navigationMetrics.time_to_first_byte;
    }
    if (this.buffer.fcp === undefined && plausible(navigationMetrics.first_contentful_paint)) {
      this.buffer.fcp = navigationMetrics.first_contentful_paint;
    }

    if (Object.keys(this.buffer).length > 0) {
      this.onFlush(this.buffer);
    }
  }

  stop(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = undefined;
    }
    this.flushed = true;
  }
}
