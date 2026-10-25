import { describe, expect, it } from "vitest";
import { AnalyticsPayloadSchema, HerculesEventSchema } from "../schema";

function pageview(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_1",
    event_type: "pageview",
    timestamp: 1_752_148_800_000,
    visitor_id: "vis_1",
    session_id: "ses_1",
    url: "https://example.com/x",
    url_path: "/x",
    ...overrides,
  };
}

describe("HerculesEventSchema caps", () => {
  it("cuts long URLs to length instead of rejecting the event", () => {
    const query = `?token=${"a".repeat(20_000)}`;
    const result = HerculesEventSchema.safeParse(
      pageview({ url: `https://example.com/x${query}`, url_query: query, referrer: query }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.url).toHaveLength(8192);
    expect(result.data?.url_query).toHaveLength(8192);
    expect(result.data?.referrer).toHaveLength(8192);
  });

  it("cuts ids and labels to length", () => {
    const result = HerculesEventSchema.safeParse(
      pageview({
        event_id: "e".repeat(500),
        browser: "b".repeat(500),
        utm_source: "u".repeat(5_000),
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data?.event_id).toHaveLength(128);
    expect(result.data?.browser).toHaveLength(128);
    expect(result.data?.utm_source).toHaveLength(512);
  });

  it("keeps the first 50 properties and cuts long keys and values", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 60 }, (_, i) => [`key_${i}`, `value_${i}`]),
    );
    properties["key_0"] = "v".repeat(5_000);
    const numeric = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`n_${i}`, i]));

    const result = HerculesEventSchema.safeParse(
      pageview({ properties, properties_numeric: numeric }),
    );

    expect(result.success).toBe(true);
    expect(Object.keys(result.data?.properties ?? {})).toHaveLength(50);
    expect(result.data?.properties?.["key_0"]).toHaveLength(2048);
    expect(result.data?.properties?.["key_49"]).toBe("value_49");
    expect(Object.keys(result.data?.properties_numeric ?? {})).toHaveLength(50);

    const longKey = HerculesEventSchema.safeParse(
      pageview({ properties: { ["k".repeat(500)]: "v" } }),
    );
    expect(Object.keys(longKey.data?.properties ?? {})).toEqual(["k".repeat(128)]);
  });

  it("still rejects a one-letter country code", () => {
    expect(HerculesEventSchema.safeParse(pageview({ country_code: "U" })).success).toBe(false);
    expect(HerculesEventSchema.safeParse(pageview({ country_code: "US" })).success).toBe(true);
    expect(
      HerculesEventSchema.safeParse(pageview({ country_code: "US".repeat(50) })).data?.country_code,
    ).toHaveLength(8);
  });
});

describe("AnalyticsPayloadSchema", () => {
  it("accepts 50 events per batch and rejects 51", () => {
    const batch = (count: number) => ({
      sent_at: 1_752_148_800_000,
      events: Array.from({ length: count }, (_, i) => pageview({ event_id: `evt_${i}` })),
    });

    expect(AnalyticsPayloadSchema.safeParse(batch(50)).success).toBe(true);
    expect(AnalyticsPayloadSchema.safeParse(batch(51)).success).toBe(false);
  });
});
