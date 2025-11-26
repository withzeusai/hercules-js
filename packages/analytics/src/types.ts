/**
 * Type definitions for @usehercules/analytics
 */

import type { HerculesEvent } from "./schema";

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
  first_input_delay?: number;
  cumulative_layout_shift?: number;
  interaction_to_next_paint?: number;
}



export interface CompressionConfig {
  enabled?: boolean;
  threshold?: number; // Minimum bytes to compress (default: 1024)
  format?: CompressionFormat; // 'gzip' | 'deflate' | 'deflate-raw'
  fallbackToUncompressed?: boolean; // Send uncompressed if compression fails
}

export interface AnalyticsConfig {
  apiEndpoint?: string;
  organizationId: string;
  websiteId: string;
  debug?: boolean;
  enabled?: boolean;
  bufferSize?: number;
  flushInterval?: number;
  trackClicks?: boolean;
  trackPerformance?: boolean;
  cookieDomain?: string;
  cookiePath?: string;
  sessionTimeout?: number; // in minutes
  compression?: CompressionConfig;
  beforeSend?: (
    events: HerculesEvent[],
  ) => HerculesEvent[] | Promise<HerculesEvent[]>;
}

export interface AnalyticsProvider {
  name: string;
  send: (events: HerculesEvent[]) => Promise<void>;
}
