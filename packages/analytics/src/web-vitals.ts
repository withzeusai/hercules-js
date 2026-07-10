// Web vitals capture with posthog-js extensions/web-vitals semantics: metrics
// buffer as they arrive and flush as one event 5 seconds after the first one.
// Unlike posthog (which lazy-loads the collector from its CDN) the web-vitals
// library is statically bundled — the artifact must stay self-contained.

import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import { WEB_VITALS_FLUSH_MS } from "./constants";
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
    if (!win || !doc || typeof PerformanceObserver === "undefined") {
      return;
    }
    const buffered = (key: keyof WebVitalsMetrics) => (metric: Metric) => {
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
    this.buffer[key] = value;
    this.flushTimeout ??= setTimeout(() => this.flush(), WEB_VITALS_FLUSH_MS);
  }

  private flush(): void {
    if (this.flushed) {
      return;
    }
    this.flushed = true;

    // Fold in navigation-timing metrics, available by now in practice since
    // the first web vital arrived at least 5 seconds ago
    const navigationMetrics = getPerformanceMetrics();
    if (navigationMetrics.page_load_time !== undefined) {
      this.buffer.plt = navigationMetrics.page_load_time;
    }
    if (navigationMetrics.dom_interactive !== undefined) {
      this.buffer.di = navigationMetrics.dom_interactive;
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
