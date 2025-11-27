import * as z from "zod/mini";

export const EventTypeEnum = z.enum([
  "pageview",
  "pageleave",
  "web_vitals",
  "click",
  "custom",
]);
export type EventType = z.infer<typeof EventTypeEnum>;

export const HerculesEventSchema = z.object({
  event_id: z.string(),
  event_type: EventTypeEnum,
  event_name: z.nullish(z.string()),
  organization_id: z.string(),
  website_id: z.string(),
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
  plt: z.nullish(z.number()), // Page Load Time
  di: z.nullish(z.number()), // DOM Interactive
  fcp: z.nullish(z.number()), // First Contentful Paint
  lcp: z.nullish(z.number()), // Largest Contentful Paint
  cls: z.nullish(z.number()), // Cumulative Layout Shift
  fid: z.nullish(z.number()), // First Input Delay
  ttfb: z.nullish(z.number()), // Time To First Byte
  inp: z.nullish(z.number()), // Interaction to Next Paint
});
export type HerculesEvent = z.infer<typeof HerculesEventSchema>;
