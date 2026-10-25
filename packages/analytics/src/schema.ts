import * as z from "zod/mini";
import { MAX_EVENTS_PER_BATCH } from "./constants";

/**
 * The ingest endpoint takes writes from anyone who can load a Hercules app, so
 * every string and map here has a cap. Values over a cap are cut to length, not
 * rejected: a rejected event fails its whole batch, and the client drops a batch
 * the server refuses.
 */
function capped(max: number) {
  return z.pipe(
    z.string(),
    z.transform((value) => value.slice(0, max)),
  );
}

/** Real URLs run past 20k characters (long query strings and hashes); this keeps the useful part. */
const URL_LENGTH = 8192;

/** A map cut to its first 50 entries, with keys cut to 128 characters. */
function cappedRecord<T>(value: z.ZodMiniType<T, T>) {
  return z.pipe(
    z.record(capped(128), value),
    z.transform((record) => Object.fromEntries(Object.entries(record).slice(0, 50))),
  );
}

export const EventTypeEnum = z.enum(["pageview", "pageleave", "web_vitals", "click", "custom"]);
export type EventType = z.infer<typeof EventTypeEnum>;

export const HerculesEventSchema = z.object({
  event_id: capped(128),
  event_type: EventTypeEnum,
  event_name: z.nullish(capped(256)),
  environment: z.nullish(capped(128)),
  timestamp: z.number(), // Unix timestamp in milliseconds
  visitor_id: capped(128),
  session_id: capped(128),
  user_id: z.nullish(capped(256)),
  origin: z.nullish(capped(256)),
  url: z.nullish(capped(URL_LENGTH)),
  url_path: capped(URL_LENGTH),
  url_query: z.nullish(capped(URL_LENGTH)),
  url_hash: z.nullish(capped(URL_LENGTH)),
  referrer: z.nullish(capped(URL_LENGTH)),
  referrer_domain: z.nullish(capped(256)),
  referrer_source: z.nullish(capped(128)),
  browser: z.nullish(capped(128)),
  browser_version: z.nullish(capped(128)),
  os: z.nullish(capped(128)),
  os_version: z.nullish(capped(128)),
  device_type: z.nullish(capped(128)),
  language: z.nullish(capped(128)),
  timezone: z.nullish(capped(128)),
  screen_width: z.nullish(z.number()),
  screen_height: z.nullish(z.number()),
  viewport_width: z.nullish(z.number()),
  viewport_height: z.nullish(z.number()),
  country_code: z.nullish(capped(8).check(z.minLength(2))),
  region: z.nullish(capped(128)),
  city: z.nullish(capped(128)),
  utm_source: z.nullish(capped(512)),
  utm_medium: z.nullish(capped(512)),
  utm_campaign: z.nullish(capped(512)),
  utm_content: z.nullish(capped(512)),
  utm_term: z.nullish(capped(512)),
  properties: z.nullish(cappedRecord(capped(2048))),
  properties_numeric: z.nullish(cappedRecord(z.number())),
  // Pageview linking (PostHog-style $pageview_id / $prev_pageview_*): every event
  // carries the id of the pageview it happened on; pageview/pageleave events also
  // carry the previous pageview's id, path, dwell time, and scroll depth so view
  // duration and bounce rate can be computed per page instead of from timestamp spread.
  pageview_id: z.nullish(capped(128)),
  prev_pageview_id: z.nullish(capped(128)),
  prev_pageview_pathname: z.nullish(capped(URL_LENGTH)),
  prev_pageview_duration: z.nullish(z.number()), // seconds
  prev_pageview_max_scroll_percentage: z.nullish(z.number()), // 0-1
  lib_version: z.nullish(capped(128)),
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
  events: z.array(HerculesEventSchema).check(z.maxLength(MAX_EVENTS_PER_BATCH)),
});
export type AnalyticsPayload = z.infer<typeof AnalyticsPayloadSchema>;
