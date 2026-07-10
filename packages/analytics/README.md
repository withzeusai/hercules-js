# @usehercules/analytics

Web analytics for Hercules applications — a "lite fork" of
[posthog-js](https://github.com/PostHog/posthog-js): the module structure and
behavioral decisions (session semantics, pageview linking, unload handling,
retry backoff, bot filtering, user-agent detection) follow upstream, trimmed
to the event surface Hercules needs. Vendored files carry a header citing
their upstream path and revision.

## Features

- 📊 **Pageviews, pageleaves, web vitals, custom events** with a flat, typed wire format
- 🔗 **Pageview linking** - every event carries the pageview it happened on; pageview/pageleave events carry the previous pageview's duration and scroll depth, so per-page view duration and bounce rate are computable server-side
- 🧭 **SPA support** - history API navigation (pushState/replaceState/popstate) captures pageviews automatically
- ⏱️ **Real sessions** - 30-minute idle timeout refreshed on activity, 24-hour maximum length, shared across tabs via localStorage
- 🚦 **Reliable delivery** - lazy batching, retry with jittered exponential backoff, offline awareness, sendBeacon + pagehide on unload
- 🤖 **Bot filtering** - events from known crawler user agents are never sent
- 🔍 **Rich context** - browser, OS, device type, language, timezone, screen/viewport, referrer, UTM parameters, and ad click IDs
- 🚀 **Core Web Vitals** - LCP, CLS, INP, FCP, TTFB via the web-vitals library
- 🎯 **TypeScript first** - the wire format is a zod schema shared with the ingest pipeline

## Installation

```bash
pnpm add @usehercules/analytics
```

## Quick Start

```typescript
import { initAnalytics } from "@usehercules/analytics";

// Initialize (auto-tracks the initial pageview and SPA navigations)
const analytics = initAnalytics({
  apiEndpoint: "/_hercules/i",
});

// Track custom events
analytics.track("signup_clicked", { plan: "pro", seats: 3 });

// Identify users — persists across page loads; an `identify` event is only
// sent when the id changes
analytics.identify("user_123");

// On logout: clears user + session; pass true to also rotate the visitor id
// so the next user on this device isn't linked to the previous one
analytics.reset(true);

// Manual pageview tracking (only needed with trackHistoryChanges: false)
analytics.trackPageview({ page_type: "product" });
```

Or embed as a script tag (served by the Hercules dispatcher at `/_hercules/i.js`):

```html
<script type="module" src="https://cdn.example.com/analytics.mjs?debug=false"></script>
```

## Configuration

```typescript
interface AnalyticsConfig {
  apiEndpoint?: string; // Analytics endpoint URL
  debug?: boolean; // Enable debug logging (default: false)
  enabled?: boolean; // Enable/disable tracking (default: true)
  bufferSize?: number; // Events per batch before an immediate flush (default: 10)
  flushInterval?: number; // How long events buffer before a flush, ms (default: 3000)
  trackPerformance?: boolean; // Capture Core Web Vitals (default: true)
  trackHistoryChanges?: boolean; // Capture SPA pageviews via history API (default: true)
  cookieDomain?: string; // Cookie domain for visitor ID
  cookiePath?: string; // Cookie path (default: '/')
  sessionTimeout?: number; // Session idle timeout in minutes (default: 30)
}
```

## Event Structure

Each event contains comprehensive data:

```typescript
interface HerculesEvent {
  // Core fields
  event_id: string;
  event_type: "pageview" | "pageleave" | "web_vitals" | "click" | "custom";
  event_name: string;
  timestamp: number;

  // User & Session
  visitor_id: string; // Persistent visitor ID (2-year cookie)
  session_id: string; // Session ID (expires after inactivity)
  user_id?: string; // Set via identify()

  // Page context
  origin: string;
  url: string;
  url_path: string;
  url_query: string;
  url_hash: string;

  // Pageview linking — every event carries the id of the pageview it happened
  // on; pageview/pageleave events also describe the previous pageview so view
  // duration and bounce rate can be computed per page
  pageview_id?: string;
  prev_pageview_id?: string;
  prev_pageview_pathname?: string;
  prev_pageview_duration?: number; // seconds
  prev_pageview_max_scroll_percentage?: number; // 0-1

  // Traffic source
  referrer: string;
  referrer_domain: string;
  referrer_source: string; // google, facebook, twitter, etc.

  // UTM parameters
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;

  // Device & Browser
  browser: string;
  browser_version: string;
  os: string;
  os_version: string;
  device_type: string; // desktop, mobile, tablet, ...
  language: string;
  timezone: string; // IANA name, e.g. "America/Los_Angeles"
  screen_width: number;
  screen_height: number;
  viewport_width: number;
  viewport_height: number;
  lib_version: string;

  // Custom properties (ad click IDs like gclid/fbclid are captured here).
  // track() values are coerced to this flat shape: finite numbers go to
  // properties_numeric; booleans/objects are stringified; null/undefined/NaN
  // are dropped
  properties: Record<string, string>;
  properties_numeric: Record<string, number>;

  // Performance metrics (web_vitals events only, abbreviated field names)
  plt?: number; // Page load time
  di?: number; // DOM interactive
  ttfb?: number; // Time to first byte
  fcp?: number; // First contentful paint
  lcp?: number; // Largest contentful paint
  cls?: number; // Cumulative layout shift
  inp?: number; // Interaction to next paint
}
```

Events are posted in batches as `{ sent_at, events }`, where `sent_at` is the
client clock at send time so the server can correct for clock skew.

## Sessions

A session is created on the first event and rotates when it has been idle for
`sessionTimeout` minutes (activity on any event resets the clock) or reaches
24 hours of total length, matching posthog-js. Session state lives in
localStorage, so a session spans tabs; the visitor ID lives in a two-year
cookie (`_hrc_vid`).

## Delivery

Events buffer and flush after `flushInterval` (or immediately at `bufferSize`
events) via `fetch` with `keepalive`. Failed batches retry with jittered
exponential backoff (6s · 2ⁿ, capped at 30 minutes, 10 attempts max) and wait
out offline periods. On `pagehide` the client sends a final pageleave and
drains all queues through `sendBeacon`. Retries can deliver a batch twice —
the ingest side deduplicates on `event_id`.

## Core Web Vitals

With `trackPerformance` enabled, LCP, CLS, INP, FCP, and TTFB are buffered as
they arrive and sent as one `web_vitals` event 5 seconds after the first
metric, together with page-load timings from the Navigation Timing API.

## License

MIT — vendored files from posthog-js are Apache-2.0 and retain their notices.
