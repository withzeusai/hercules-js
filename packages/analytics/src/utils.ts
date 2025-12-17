/**
 * Utility functions for @usehercules/analytics
 */

import { ulid } from "ulid";
import { onCLS, onFCP, onLCP, onTTFB, onINP, type Metric } from "web-vitals";
import Bowser from "bowser";
import type {
  BrowserInfo,
  OSInfo,
  ReferrerInfo,
  UTMParams,
  PerformanceMetrics,
} from "./types";

/**
 * Generate a unique ID using ULID
 */
export function generateId(): string {
  return ulid();
}

/**
 * Get a cookie value by name
 */
export function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) {
    const part = parts.pop();
    if (part) {
      return part.split(";").shift() || null;
    }
  }
  return null;
}

/**
 * Set a cookie
 */
export function setCookie(
  name: string,
  value: string,
  days: number,
  domain?: string,
  path = "/",
): void {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  let cookie = `${name}=${value}; expires=${expires}; path=${path}; SameSite=Lax`;
  if (domain) {
    cookie += `; domain=${domain}`;
  }
  document.cookie = cookie;
}

/**
 * Parse user agent to extract browser and OS information using Bowser
 */
export function parseUserAgent(ua = navigator.userAgent): {
  browser: BrowserInfo;
  os: OSInfo;
  deviceType: string;
  deviceVendor?: string;
  deviceModel?: string;
  isBot?: boolean;
} {
  const parser = Bowser.getParser(ua);
  const browserInfo = parser.getBrowser();
  const osInfo = parser.getOS();
  const platformInfo = parser.getPlatform();

  // Get browser info
  const browser: BrowserInfo = {
    name: browserInfo.name?.toLowerCase() || "",
    version: browserInfo.version?.split(".")[0] || "", // Major version only for consistency
  };

  // Get OS info
  const os: OSInfo = {
    name: osInfo.name?.toLowerCase().replace(/ /g, "") || "", // Remove spaces for consistency (e.g., "Mac OS" -> "macos")
    version: osInfo.version || "",
  };

  // Normalize OS names to match existing format
  if (os.name === "macos") {
    os.name = "macos";
  } else if (os.name === "windows") {
    os.name = "windows";
  } else if (os.name === "ios") {
    os.name = "ios";
  } else if (os.name === "android") {
    os.name = "android";
  } else if (os.name.includes("linux")) {
    os.name = "linux";
  }

  // Get device type
  const platformType = platformInfo.type;
  let deviceType = "desktop";

  if (platformType === "mobile") {
    deviceType = "mobile";
  } else if (platformType === "tablet") {
    deviceType = "tablet";
  } else if (platformType === "tv") {
    deviceType = "tv";
  } else if (platformType === "wearable") {
    deviceType = "wearable";
  } else if (platformType === "embedded") {
    deviceType = "embedded";
  }

  // Get additional device info if available
  const deviceVendor = platformInfo.vendor;
  const deviceModel = platformInfo.model;

  // Check if it's a bot
  const isBot =
    parser.satisfies({
      crawler: ["bot", "crawler", "spider", "crawling"],
    }) || parser.getBrowserName() === "bot";

  return {
    browser,
    os,
    deviceType,
    ...(deviceVendor && { deviceVendor }),
    ...(deviceModel && { deviceModel }),
    ...(isBot && { isBot }),
  };
}

/**
 * Get referrer information
 */
export function getReferrerInfo(): ReferrerInfo {
  const referrer = document.referrer;
  if (!referrer) {
    return {
      referrer: "",
      referrer_domain: "",
      referrer_source: "direct",
    };
  }

  try {
    const url = new URL(referrer);
    const domain = url.hostname;
    let source = "referral";

    // Detect common sources
    const sourceMap: Record<string, string[]> = {
      google: ["google."],
      facebook: ["facebook.", "fb."],
      twitter: ["twitter.", "t.co", "x.com"],
      linkedin: ["linkedin."],
      instagram: ["instagram."],
      youtube: ["youtube."],
      reddit: ["reddit."],
      pinterest: ["pinterest."],
      bing: ["bing."],
      yahoo: ["yahoo."],
      duckduckgo: ["duckduckgo."],
      baidu: ["baidu."],
      yandex: ["yandex."],
      tiktok: ["tiktok."],
    };

    for (const [key, domains] of Object.entries(sourceMap)) {
      if (domains.some((d) => domain.includes(d))) {
        source = key;
        break;
      }
    }

    return {
      referrer,
      referrer_domain: domain,
      referrer_source: source,
    };
  } catch (e) {
    return {
      referrer,
      referrer_domain: "",
      referrer_source: "unknown",
    };
  }
}

/**
 * Get UTM parameters from URL
 */
export function getUTMParams(url?: string): UTMParams {
  const params = new URLSearchParams(url || window.location.search);
  return {
    utm_source: params.get("utm_source") || "",
    utm_medium: params.get("utm_medium") || "",
    utm_campaign: params.get("utm_campaign") || "",
    utm_content: params.get("utm_content") || "",
    utm_term: params.get("utm_term") || "",
  };
}

/**
 * Get performance metrics including Core Web Vitals
 */
export function getPerformanceMetrics(): PerformanceMetrics {
  const metrics: PerformanceMetrics = {};

  if (typeof window === "undefined" || !("performance" in window)) {
    return metrics;
  }

  // Try to use modern Navigation Timing API (Level 2) first
  if (
    window.performance &&
    typeof window.performance.getEntriesByType === "function"
  ) {
    try {
      // Get navigation timing using modern API
      const navigationEntries = performance.getEntriesByType(
        "navigation",
      ) as PerformanceNavigationTiming[];
      if (navigationEntries.length > 0) {
        const navTiming = navigationEntries[0];
        if (navTiming) {
          // Calculate metrics from PerformanceNavigationTiming
          const pageLoadTime = navTiming.loadEventEnd - navTiming.fetchStart;
          const domInteractive =
            navTiming.domInteractive - navTiming.fetchStart;
          const ttfb = navTiming.responseStart - navTiming.requestStart;

          if (pageLoadTime > 0 && isFinite(pageLoadTime)) {
            metrics.page_load_time = Math.round(pageLoadTime);
          }
          if (domInteractive > 0 && isFinite(domInteractive)) {
            metrics.dom_interactive = Math.round(domInteractive);
          }
          if (ttfb > 0 && isFinite(ttfb)) {
            metrics.time_to_first_byte = Math.round(ttfb);
          }
        }
      }
    } catch (e) {
      // Navigation Timing API Level 2 not supported, will fall back to Level 1
    }
  }

  // Fallback to deprecated performance.timing if modern API didn't work
  if (!metrics.page_load_time && performance.timing) {
    const timing = performance.timing;
    const pageLoadTime = timing.loadEventEnd - timing.navigationStart;
    const domInteractive = timing.domInteractive - timing.navigationStart;
    const ttfb = timing.responseStart - timing.navigationStart;

    if (pageLoadTime > 0 && isFinite(pageLoadTime)) {
      metrics.page_load_time = Math.round(pageLoadTime);
    }
    if (domInteractive > 0 && isFinite(domInteractive)) {
      metrics.dom_interactive = Math.round(domInteractive);
    }
    if (ttfb > 0 && isFinite(ttfb)) {
      metrics.time_to_first_byte = Math.round(ttfb);
    }
  }

  // Get paint metrics (these use the modern Paint Timing API)
  if (
    window.performance &&
    typeof window.performance.getEntriesByType === "function"
  ) {
    try {
      const paintEntries = performance.getEntriesByType(
        "paint",
      ) as PerformanceEntry[];
      const fcpEntry = paintEntries.find(
        (entry) => entry.name === "first-contentful-paint",
      );
      if (fcpEntry) {
        metrics.first_contentful_paint = Math.round(fcpEntry.startTime);
      }
    } catch (e) {
      // Paint metrics not supported
    }
  }

  return metrics;
}

/**
 * Observe Core Web Vitals using the web-vitals library
 */
export function observeWebVitals(
  callback: (metrics: PerformanceMetrics) => void,
): void {
  if (typeof window === "undefined") {
    return;
  }

  const metrics: PerformanceMetrics = {};

  // Helper to update metrics and trigger callback
  const updateMetrics = (name: keyof PerformanceMetrics, value: number) => {
    metrics[name] = Math.round(value);
    callback({ ...metrics });
  };

  // Cumulative Layout Shift (CLS)
  onCLS(
    (metric: Metric) => {
      // CLS is a decimal, keep 3 decimal places
      metrics.cumulative_layout_shift = Math.round(metric.value * 1000) / 1000;
      callback({ ...metrics });
    },
    { reportAllChanges: false },
  ); // Only report the final value

  // First Contentful Paint (FCP)
  onFCP((metric: Metric) => {
    updateMetrics("first_contentful_paint", metric.value);
  });

  // First Input Delay (FID) is deprecated in web-vitals v4+
  // We now use INP (Interaction to Next Paint) which is a better metric
  // But we'll map INP to first_input_delay for backward compatibility if needed

  // Largest Contentful Paint (LCP)
  onLCP(
    (metric: Metric) => {
      updateMetrics("largest_contentful_paint", metric.value);
    },
    { reportAllChanges: false },
  ); // Only report the final value

  // Time to First Byte (TTFB)
  onTTFB((metric: Metric) => {
    updateMetrics("time_to_first_byte", metric.value);
  });

  // Interaction to Next Paint (INP) - newer metric replacing FID
  onINP(
    (metric: Metric) => {
      updateMetrics("interaction_to_next_paint", metric.value);
      // Also map to first_input_delay for backward compatibility
      // Note: INP and FID are different metrics, but INP is the recommended replacement
      if (metrics.first_input_delay === undefined) {
        updateMetrics("first_input_delay", metric.value);
      }
    },
    { reportAllChanges: false },
  );

  // Also get page load time from Navigation Timing API
  // This will be called once the page is fully loaded
  if (
    window.performance &&
    typeof window.performance.getEntriesByType === "function"
  ) {
    // Use a small delay to ensure load event has fired
    const checkPageLoad = () => {
      try {
        const navigationEntries = performance.getEntriesByType(
          "navigation",
        ) as PerformanceNavigationTiming[];
        if (navigationEntries.length > 0) {
          const navTiming = navigationEntries[0];
          if (navTiming && navTiming.loadEventEnd > 0) {
            const pageLoadTime = navTiming.loadEventEnd - navTiming.fetchStart;
            if (pageLoadTime > 0 && isFinite(pageLoadTime)) {
              updateMetrics("page_load_time", pageLoadTime);
            }
            // Also update dom_interactive while we're here
            const domInteractive =
              navTiming.domInteractive - navTiming.fetchStart;
            if (domInteractive > 0 && isFinite(domInteractive)) {
              updateMetrics("dom_interactive", domInteractive);
            }
          } else {
            // Page not fully loaded yet, check again
            setTimeout(checkPageLoad, 100);
          }
        }
      } catch (e) {
        // Fallback to old API if needed
        if (performance.timing && performance.timing.loadEventEnd > 0) {
          const timing = performance.timing;
          const pageLoadTime = timing.loadEventEnd - timing.navigationStart;
          if (pageLoadTime > 0 && isFinite(pageLoadTime)) {
            updateMetrics("page_load_time", pageLoadTime);
          }
          const domInteractive = timing.domInteractive - timing.navigationStart;
          if (domInteractive > 0 && isFinite(domInteractive)) {
            updateMetrics("dom_interactive", domInteractive);
          }
        }
      }
    };

    // Start checking after a small delay
    if (document.readyState === "complete") {
      setTimeout(checkPageLoad, 0);
    } else {
      window.addEventListener("load", () => {
        setTimeout(checkPageLoad, 0);
      });
    }
  }
}

/**
 * Debounce function for rate-limiting events
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

/**
 * Throttle function for rate-limiting events
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number,
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Safe JSON stringify that handles circular references
 */
export function safeStringify(obj: any): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  });
}

/**
 * Get browser information with enhanced Bowser data
 */
export function getBrowserInfo(): Record<string, any> {
  if (typeof window === "undefined") return {};

  const { browser, os, deviceType, deviceVendor, deviceModel, isBot } =
    parseUserAgent();
  const parser = Bowser.getParser(navigator.userAgent);

  // Get additional browser capabilities
  const engineInfo = parser.getEngine();
  const browserFeatures = {
    isMobile: parser.getPlatformType() === "mobile",
    isTablet: parser.getPlatformType() === "tablet",
    isDesktop: parser.getPlatformType() === "desktop",
    isTouchEnabled: "ontouchstart" in window || navigator.maxTouchPoints > 0,
  };

  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine,
    screenResolution: `${screen.width}x${screen.height}`,
    screenColorDepth: screen.colorDepth,
    pixelRatio: window.devicePixelRatio || 1,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    referrer: document.referrer,
    url: window.location.href,
    title: document.title,
    browser: browser.name,
    browserVersion: browser.version,
    browserEngine: engineInfo.name || "",
    browserEngineVersion: engineInfo.version || "",
    os: os.name,
    osVersion: os.version,
    deviceType,
    deviceVendor,
    deviceModel,
    isBot,
    ...browserFeatures,
  };
}

