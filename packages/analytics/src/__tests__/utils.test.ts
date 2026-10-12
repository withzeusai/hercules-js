import { describe, expect, it } from "vitest";
import { getReferrerInfo } from "../utils";

describe("getReferrerInfo", () => {
  it("classifies direct traffic when there is no referrer", () => {
    expect(getReferrerInfo("")).toEqual({
      referrer: "",
      referrer_domain: "",
      referrer_source: "direct",
    });
  });

  it("classifies known sources across TLDs and subdomains", () => {
    expect(getReferrerInfo("https://www.google.com/search").referrer_source).toBe("google");
    expect(getReferrerInfo("https://google.co.uk/").referrer_source).toBe("google");
    expect(getReferrerInfo("https://t.co/abc").referrer_source).toBe("twitter");
    expect(getReferrerInfo("https://www.t.co/abc").referrer_source).toBe("twitter");
    expect(getReferrerInfo("https://x.com/user/status/1").referrer_source).toBe("twitter");
    expect(getReferrerInfo("https://m.facebook.com/").referrer_source).toBe("facebook");
    expect(getReferrerInfo("https://duckduckgo.com/?q=x").referrer_source).toBe("duckduckgo");
  });

  it("does not match source patterns inside unrelated hostnames", () => {
    // Every one of these was misclassified by the old substring matching
    expect(getReferrerInfo("https://test.com/").referrer_source).toBe("referral"); // contains "t.co"
    expect(getReferrerInfo("https://notgoogle.example.com/").referrer_source).toBe("referral");
    expect(getReferrerInfo("https://sfb.example.org/").referrer_source).toBe("referral"); // contains "fb."
    expect(getReferrerInfo("https://mybing.example.net/").referrer_source).toBe("referral");
  });

  it("classifies unknown domains as referral with the domain preserved", () => {
    expect(getReferrerInfo("https://blog.example.com/post")).toEqual({
      referrer: "https://blog.example.com/post",
      referrer_domain: "blog.example.com",
      referrer_source: "referral",
    });
  });

  it("marks unparseable referrers as unknown", () => {
    expect(getReferrerInfo("not a url").referrer_source).toBe("unknown");
  });
});
