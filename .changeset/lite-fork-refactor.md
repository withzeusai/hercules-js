---
"@usehercules/analytics": major
---

Refactor into a posthog-js "lite fork": module structure and behavioral decisions follow upstream posthog-js, trimmed to the event surface Hercules needs. The wire format is unchanged from 1.1.0.

**New behavior**

- SPA pageviews: history API navigations (pushState/replaceState/popstate) capture pageviews automatically (`trackHistoryChanges`, default true), with pageview linking across client-side routes.
- Real sessions: 30-minute idle timeout refreshed on every event, 24-hour maximum session length, state shared across tabs via localStorage (previously per-tab sessionStorage whose timeout never fired). In-flight legacy sessions are migrated.
- Reliable delivery: lazy batching (3s default), retry with jittered exponential backoff and offline awareness; pageleave now fires on `pagehide` instead of the unreliable `beforeunload`, and unload drains all queues via sendBeacon.
- Bot filtering: events from known crawler user agents (posthog blocklist) are never sent.
- User-agent detection: vendored posthog detectors replace Bowser (names normalized to the existing lowercase dimension values); browser bundle drops from ~57 KB to ~30 KB minified.

**Breaking changes**

- Removed the provider system (`AnalyticsProvider`, `ConsoleProvider`, `addProvider`, `removeProvider`) — use `debug` for local inspection.
- Removed `trackClicks` config and click autocapture.
- Removed utility exports: `debounce`, `throttle`, `safeStringify`, `getBrowserInfo`, `observeWebVitals`; `parseUserAgent` now returns only `{ browser, os, deviceType }`.
- `flush()` is synchronous (returns void, not a Promise).
- Web vitals are sent as one `web_vitals` event ~5s after the first metric; pageviews no longer carry performance fields.
