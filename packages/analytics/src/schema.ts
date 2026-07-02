import * as z from "zod/mini";

export const EventTypeEnum = z.enum(["pageview", "pageleave", "web_vitals", "click", "custom"]);
export type EventType = z.infer<typeof EventTypeEnum>;

export const HerculesEventSchema = z.object({
  event_id: z.string(),
  event_type: EventTypeEnum,
  event_name: z.nullish(z.string()),
  environment: z.nullish(z.string()),
  timestamp: z.number(), // Unix timestamp in milliseconds
  visitor_id: z.string(),
  session_id: z.string(),
  user_id: z.nullish(z.string()),
  origin: z.nullish(z.string()),
  url: z.nullish(z.string()),
  url_path: z.string(),
  url_query: z.nullish(z.string()),
  url_hash: z.nullish(z.string()),
  referrer: z.nullish(z.string()),
  referrer_domain: z.nullish(z.string()),
  referrer_source: z.nullish(z.string()),
  browser: z.nullish(z.string()),
  browser_version: z.nullish(z.string()),
  os: z.nullish(z.string()),
  os_version: z.nullish(z.string()),
  device_type: z.nullish(z.string()),
  language: z.nullish(z.string()),
  timezone: z.nullish(z.string()),
  screen_width: z.nullish(z.number()),
  screen_height: z.nullish(z.number()),
  viewport_width: z.nullish(z.number()),
  viewport_height: z.nullish(z.number()),
  country_code: z.nullish(z.string().check(z.minLength(2))),
  region: z.nullish(z.string()),
  city: z.nullish(z.string()),
  utm_source: z.nullish(z.string()),
  utm_medium: z.nullish(z.string()),
  utm_campaign: z.nullish(z.string()),
  utm_content: z.nullish(z.string()),
  utm_term: z.nullish(z.string()),
  properties: z.nullish(z.record(z.string(), z.string())),
  properties_numeric: z.nullish(z.record(z.string(), z.number())),
  // Pageview linking (PostHog-style $pageview_id / $prev_pageview_*): every event
  // carries the id of the pageview it happened on; pageview/pageleave events also
  // carry the previous pageview's id, path, dwell time, and scroll depth so view
  // duration and bounce rate can be computed per page instead of from timestamp spread.
  pageview_id: z.nullish(z.string()),
  prev_pageview_id: z.nullish(z.string()),
  prev_pageview_pathname: z.nullish(z.string()),
  prev_pageview_duration: z.nullish(z.number()), // seconds
  prev_pageview_max_scroll_percentage: z.nullish(z.number()), // 0-1
  lib_version: z.nullish(z.string()),
  plt: z.nullish(z.number()), // Page Load Time
  di: z.nullish(z.number()), // DOM Interactive
  fcp: z.nullish(z.number()), // First Contentful Paint
  lcp: z.nullish(z.number()), // Largest Contentful Paint
  cls: z.nullish(z.number()), // Cumulative Layout Shift
  fid: z.nullish(z.number()), // First Input Delay — deprecated; new clients no longer send it (use inp)
  ttfb: z.nullish(z.number()), // Time To First Byte
  inp: z.nullish(z.number()), // Interaction to Next Paint
});
export type HerculesEvent = z.infer<typeof HerculesEventSchema>;

// Batch envelope posted to the ingest endpoint. `sent_at` is the client clock at
// send time so the server can correct event timestamps for clock skew
// (offset = server now - sent_at). Optional for backward compatibility with
// older clients that post a bare { events } payload.
export const AnalyticsPayloadSchema = z.object({
  sent_at: z.nullish(z.number()), // Unix timestamp in milliseconds
  events: z.array(HerculesEventSchema),
});
export type AnalyticsPayload = z.infer<typeof AnalyticsPayloadSchema>;
