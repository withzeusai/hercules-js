import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "../request";

describe("request", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // jsdom has no sendBeacon; remove anything a test defined
    delete (navigator as { sendBeacon?: unknown }).sendBeacon;
  });

  it("reports success when sendBeacon queues the payload", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });
    const callback = vi.fn();

    request({ url: "/i", body: "{}", transport: "sendBeacon", callback });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ statusCode: 200 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to fetch when sendBeacon rejects the payload", () => {
    const sendBeacon = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, "sendBeacon", { value: sendBeacon, configurable: true });

    request({ url: "/i", body: "{}", transport: "sendBeacon" });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses fetch for the default transport", () => {
    request({ url: "/i", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports statusCode 0 when fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const callback = vi.fn();

    request({ url: "/i", body: "{}", callback });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith({ statusCode: 0 }));
  });
});
