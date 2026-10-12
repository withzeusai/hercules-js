# @usehercules/analytics

## 2.0.1

### Patch Changes

- [#103](https://github.com/withzeusai/hercules-js/pull/103) [`65dd8b4`](https://github.com/withzeusai/hercules-js/commit/65dd8b4feaff558d6a9d7cca7a3a7116f961098c) Thanks [@grant0417](https://github.com/grant0417)! - Fix four behaviors against upstream posthog-js:

  - **Referrer matching**: source classification now matches hostname label boundaries instead of substrings, so `test.com` is no longer classified as Twitter (via `t.co`) and `notgoogle.example.com` is no longer classified as Google.
  - **Property coercion**: `track()` property values are coerced to the flat wire format — finite numbers go to `properties_numeric`, booleans/objects are stringified, and `null`/`undefined`/`NaN` are dropped, so nothing schema-invalid reaches ingest.
  - **Persisted identity**: `identify()` persists the user id in localStorage (`_hrc_uid`) so reloads keep identity, and only emits an identify event when the id changes, mirroring posthog-js `$identify` semantics.
  - **reset(resetVisitorId?)**: clears the persisted user id and optionally rotates the visitor cookie on logout, mirroring posthog-js `reset(reset_device_id)`.
  - **Web vitals on page hide**: the `web_vitals` event now flushes when the page is hidden/unloading, not only on the 5s timer, so bounces shorter than 5s still report and terminal LCP/CLS/INP (which settle at page-hide) are captured. Implausible values (≥ 15 min) are dropped, and the Navigation Timing TTFB fallback now uses web-vitals' `onTTFB` baseline (`responseStart`) so it stays comparable with the primary metric.

## 2.0.0

### Major Changes

- [#101](https://github.com/withzeusai/hercules-js/pull/101) [`1af65b6`](https://github.com/withzeusai/hercules-js/commit/1af65b69f4cddb318a2178cee3f25c6b1b6b175f) Thanks [@grant0417](https://github.com/grant0417)! - Refactor into a posthog-js "lite fork": module structure and behavioral decisions follow upstream posthog-js, trimmed to the event surface Hercules needs. The wire format is unchanged from 1.1.0.

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

### Minor Changes

- [#100](https://github.com/withzeusai/hercules-js/pull/100) [`ce0c57c`](https://github.com/withzeusai/hercules-js/commit/ce0c57c01298bf63dc3ecf109c687dd42f81cbed) Thanks [@grant0417](https://github.com/grant0417)! - Extend the wire format for accurate view duration and bounce rate, plus richer dimensions:

  - Pageview linking (PostHog-style): every event carries `pageview_id`; pageview/pageleave events carry `prev_pageview_id`, `prev_pageview_pathname`, `prev_pageview_duration` (seconds), and `prev_pageview_max_scroll_percentage` so per-page dwell time and bounce rate can be computed server-side.
  - New dimensions on every event: `device_type`, `language`, `timezone`, `screen_width/height`, `viewport_width/height`, `lib_version`.
  - Ad click IDs (`gclid`, `fbclid`, `ttclid`, `msclkid`, etc.) are captured into `properties`.
  - Batches are now posted as `{ sent_at, events }` so the server can correct client clock skew (old bare `{ events }` payloads remain valid — `sent_at` is optional in `AnalyticsPayloadSchema`).
  - FID is no longer reported (it was an alias of INP); `first_input_delay` stays in the schema for old clients. Basic perf metrics (`plt`/`di`/`ttfb`) now ride only on `web_vitals` events instead of duplicating onto pageviews.

## 1.0.41

### Patch Changes

- [#14](https://github.com/withzeusai/hercules-js/pull/14) [`5efd2ba`](https://github.com/withzeusai/hercules-js/commit/5efd2bacb54710376c585f4362c0e7988e8bf7fb) Thanks [@grant0417](https://github.com/grant0417)! - Add changesets for package versioning and publishing
