import { describe, expect, it } from "vitest";
import { isBlockedUA } from "../blocked-uas";
import { parseUserAgent } from "../utils";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

// Names must stay lowercase and continuous with the values the pre-2.0
// (Bowser-based) client stored, since they are dashboard dimensions.
describe("parseUserAgent", () => {
  it("detects desktop Chrome on macOS", () => {
    const { browser, os, deviceType } = parseUserAgent(CHROME_MAC);
    expect(browser.name).toBe("chrome");
    expect(browser.version).toBe("126");
    expect(os.name).toBe("macos");
    expect(deviceType).toBe("desktop");
  });

  it("normalizes Mobile Safari to safari on iOS", () => {
    const { browser, os, deviceType } = parseUserAgent(SAFARI_IOS);
    expect(browser.name).toBe("safari");
    expect(os.name).toBe("ios");
    expect(os.version).toBe("17.5.0");
    expect(deviceType).toBe("mobile");
  });

  it("normalizes Chrome iOS to chrome", () => {
    expect(parseUserAgent(CHROME_IOS).browser.name).toBe("chrome");
  });

  it("detects Firefox on Windows", () => {
    const { browser, os } = parseUserAgent(FIREFOX_WINDOWS);
    expect(browser.name).toBe("firefox");
    expect(browser.version).toBe("127");
    expect(os.name).toBe("windows");
  });

  it("detects Edge as its own browser", () => {
    expect(parseUserAgent(EDGE_WINDOWS).browser.name).toBe("microsoft edge");
  });

  it("detects Android Chrome as mobile", () => {
    const { browser, os, deviceType } = parseUserAgent(ANDROID_CHROME);
    expect(browser.name).toBe("chrome");
    expect(os.name).toBe("android");
    expect(deviceType).toBe("mobile");
  });
});

describe("isBlockedUA", () => {
  it.each([
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  ])("blocks %s", (ua) => {
    expect(isBlockedUA(ua)).toBe(true);
  });

  it("does not block real browsers", () => {
    expect(isBlockedUA(CHROME_MAC)).toBe(false);
    expect(isBlockedUA(SAFARI_IOS)).toBe(false);
  });
});
