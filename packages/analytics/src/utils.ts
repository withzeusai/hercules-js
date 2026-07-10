/**
 * Utility functions for @usehercules/analytics
 */

import { ulid } from "ulid";
import { doc, nav, win } from "./globals";
import type { BrowserInfo, OSInfo, PerformanceMetrics, ReferrerInfo, UTMParams } from "./types";
import {
  detectBrowser,
  detectBrowserVersion,
  detectDeviceType,
  detectOS,
} from "./user-agent-utils";

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

// Detection comes from the vendored posthog detectors, but names are
// normalized to the lowercase conventions this package has always sent so
// stored dashboard dimensions stay continuous (e.g. "chrome", not "Chrome").
const OS_NAME_MAP: Record<string, string> = {
  "mac os x": "macos",
  "chrome os": "chromeos",
};

const BROWSER_NAME_MAP: Record<string, string> = {
  "mobile safari": "safari",
  "chrome ios": "chrome",
  "firefox ios": "firefox",
  "internet explorer mobile": "internet explorer",
};

/**
 * Parse a user agent into browser, OS, and device-type information
 */
export function parseUserAgent(
  ua?: string,
  vendor?: string,
): {
  browser: BrowserInfo;
  os: OSInfo;
  deviceType: string;
} {
  const userAgent = ua ?? nav?.userAgent ?? "";
  // navigator.vendor only describes the UA it came with — never mix the
  // environment's vendor with an explicitly passed user agent string
  const effectiveVendor = vendor ?? (ua === undefined ? (nav?.vendor ?? "") : "");
  // Desktop/Android Brave is Chromium with no UA marker; it exposes navigator.brave
  const hints = (nav as { brave?: unknown } | undefined)?.brave ? { brave: true as const } : {};

  const rawBrowser = detectBrowser(userAgent, effectiveVendor, hints).toLowerCase();
  const browserName = BROWSER_NAME_MAP[rawBrowser] ?? rawBrowser;
  const rawVersion = detectBrowserVersion(userAgent, effectiveVendor, hints);
  const browserVersion = rawVersion == null ? "" : String(rawVersion).split(".")[0] || "";

  const [rawOsName, osVersion] = detectOS(userAgent);
  const lowerOs = rawOsName.toLowerCase();
  let osName = OS_NAME_MAP[lowerOs] ?? lowerOs.replace(/ /g, "");
  if (osName.includes("linux")) {
    osName = "linux";
  }

  return {
    browser: { name: browserName, version: browserVersion },
    os: { name: osName, version: osVersion },
    deviceType: detectDeviceType(userAgent, {
      userAgentDataPlatform: (nav as { userAgentData?: { platform?: string } } | undefined)
        ?.userAgentData?.platform,
      maxTouchPoints: nav?.maxTouchPoints,
      screenWidth: win?.screen?.width,
      screenHeight: win?.screen?.height,
      devicePixelRatio: win?.devicePixelRatio,
    }).toLowerCase(),
  };
}

// Known referrer sources. posthog-js only classifies four search engines
// client-side (event-utils.ts _getSearchEngine) and leaves channel typing to
// the server; this broader map is a Hercules divergence. Patterns ending in
// "." match a domain label with any TLD ("google." → google.com,
// www.google.co.uk); other patterns match the registered domain or a
// subdomain of it ("t.co" → t.co, www.t.co — not test.com).
const REFERRER_SOURCE_MAP: Record<string, string[]> = {
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

function hostnameMatches(hostname: string, pattern: string): boolean {
  if (pattern.endsWith(".")) {
    return hostname.startsWith(pattern) || hostname.includes(`.${pattern}`);
  }
  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

/**
 * Get referrer information (pass a referrer explicitly to override
 * `document.referrer`, e.g. in tests)
 */
export function getReferrerInfo(referrerOverride?: string): ReferrerInfo {
  const referrer = referrerOverride ?? doc?.referrer ?? "";
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

    for (const [key, domains] of Object.entries(REFERRER_SOURCE_MAP)) {
      if (domains.some((d) => hostnameMatches(domain, d))) {
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
 * Ad click-ID query parameters, kept in sync with posthog-js CAMPAIGN_PARAMS.
 * Paid traffic often arrives with only one of these and no UTM parameters.
 */
const CLICK_ID_PARAMS = [
  "gclid", // google ads
  "gclsrc", // google ads 360
  "dclid", // google display ads
  "gbraid", // google ads, web to app
  "wbraid", // google ads, app to web
  "gad_source", // google ads source
  "fbclid", // facebook
  "msclkid", // microsoft
  "twclid", // twitter
  "li_fat_id", // linkedin
  "igshid", // instagram
  "ttclid", // tiktok
  "rdt_cid", // reddit
  "epik", // pinterest
  "qclid", // quora
  "sccid", // snapchat
  "irclid", // impact
  "_kx", // klaviyo
  "mc_cid", // mailchimp campaign id
];

/**
 * Get ad click-ID parameters present in the URL (only keys that are set)
 */
export function getClickIds(url?: string): Record<string, string> {
  const params = new URLSearchParams(url || window.location.search);
  const clickIds: Record<string, string> = {};
  for (const key of CLICK_ID_PARAMS) {
    const value = params.get(key);
    if (value) {
      clickIds[key] = value;
    }
  }
  return clickIds;
}

/**
 * Get the IANA timezone of the browser, e.g. "America/Los_Angeles"
 */
export function getTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
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
 * Get page-load performance metrics from the Navigation Timing API
 */
export function getPerformanceMetrics(): PerformanceMetrics {
  const metrics: PerformanceMetrics = {};

  if (!win || !("performance" in win) || typeof performance.getEntriesByType !== "function") {
    return metrics;
  }

  try {
    const [navTiming] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (navTiming) {
      const pageLoadTime = navTiming.loadEventEnd - navTiming.fetchStart;
      const domInteractive = navTiming.domInteractive - navTiming.fetchStart;
      // TTFB is measured from the navigation start (fetchStart), not requestStart
      // — the old formula captured only server think time and excluded
      // DNS/TCP/TLS, undercounting it and disagreeing with web-vitals' onTTFB
      const ttfb = navTiming.responseStart - navTiming.fetchStart;

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

    const paintEntries = performance.getEntriesByType("paint");
    const fcpEntry = paintEntries.find((entry) => entry.name === "first-contentful-paint");
    if (fcpEntry) {
      metrics.first_contentful_paint = Math.round(fcpEntry.startTime);
    }
  } catch (e) {
    // Navigation Timing not supported
  }

  return metrics;
}
