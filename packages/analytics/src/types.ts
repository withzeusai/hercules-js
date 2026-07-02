/**
 * Type definitions for @usehercules/analytics
 */

export interface BrowserInfo {
  name: string;
  version: string;
}

export interface OSInfo {
  name: string;
  version: string;
}

export interface ReferrerInfo {
  referrer: string;
  referrer_domain: string;
  referrer_source: string;
}

export interface UTMParams {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
}

export interface PerformanceMetrics {
  page_load_time?: number;
  dom_interactive?: number;
  time_to_first_byte?: number;
  first_contentful_paint?: number;
  largest_contentful_paint?: number;
  cumulative_layout_shift?: number;
  interaction_to_next_paint?: number;
}

export interface AnalyticsConfig {
  apiEndpoint?: string;
  debug?: boolean;
  enabled?: boolean;
  /** Events per batch before an immediate flush */
  bufferSize?: number;
  /** How long events buffer before a flush, in ms */
  flushInterval?: number;
  /** Capture Core Web Vitals (default: true) */
  trackPerformance?: boolean;
  /** Capture SPA pageviews via the history API (default: true) */
  trackHistoryChanges?: boolean;
  cookieDomain?: string;
  cookiePath?: string;
  /** Session idle timeout in minutes (default: 30) */
  sessionTimeout?: number;
}
