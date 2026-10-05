// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  getToken: vi.fn(async () => "turnstile-token"),
  reset: vi.fn(),
  destroy: vi.fn(),
  iframe: { isConnected: true },
}));
const mount = vi.hoisted(() => vi.fn(() => bridge));
vi.mock("./captcha", () => ({ mountTurnstileBridge: mount }));

const { createEmbeddedAuthClient } = await import("./client");

const ORIGIN = "https://theirapp.com";
const SIGNED = "client_id=c&exp=1&sig=abc";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function location(search = `?${SIGNED}`) {
  return {
    origin: ORIGIN,
    search,
    pathname: "/sign-in",
    href: `${ORIGIN}/sign-in${search}`,
    assign: vi.fn(),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("automatic captcha", () => {
  it("renders the widget in #hercules-captcha and sends its token", async () => {
    document.body.innerHTML = '<div id="hercules-captcha"></div>';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ issuer: "https://tenant.hercules-auth.com", language: "en" }))
      .mockResolvedValueOnce(json({ redirect: true, url: "/auth/callback?code=x" }));
    const client = createEmbeddedAuthClient({ fetch, location: location() });

    const result = await client.authenticateWithPassword({
      email: "a@example.com",
      password: "pw",
    });

    expect(result).toMatchObject({ ok: true });
    expect(mount).toHaveBeenCalledWith({
      issuer: "https://tenant.hercules-auth.com",
      container: document.getElementById("hercules-captcha"),
      language: "en",
    });
    expect(fetch.mock.calls[1]![1].headers["x-captcha-response"]).toBe("turnstile-token");
    expect(bridge.reset).toHaveBeenCalledOnce();
  });

  it("falls back to a corner panel and skips endpoints without captcha", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ issuer: "https://tenant.hercules-auth.com", language: "en" }))
      .mockResolvedValue(json({ status: true }));
    const client = createEmbeddedAuthClient({ fetch, location: location() });

    await client.sendMagicAuthCode({ email: "a@example.com" });
    await client.revokeOtherSessions();

    expect(document.querySelector("[data-hercules-captcha]")).not.toBeNull();
    expect(mount).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[2]![1].headers["x-captcha-response"]).toBeUndefined();
  });

  it("leaves tokens to the caller in manual mode", async () => {
    const fetch = vi.fn(async () => json({ redirect: true, url: "/auth/callback?code=x" }));
    const client = createEmbeddedAuthClient({ fetch, location: location(), captcha: "manual" });

    await client.authenticateWithPassword({
      email: "a@example.com",
      password: "pw",
      captchaToken: "mine",
    });

    expect(mount).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]![1].headers["x-captcha-response"]).toBe("mine");
  });

  it("reports a captcha that cannot load instead of sending the request", async () => {
    const fetch = vi.fn(async () => json({ message: "Tenant not found" }, 404));
    const client = createEmbeddedAuthClient({ fetch, location: location() });

    const result = await client.sendSmsCode({ phoneNumber: "+14155550123" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "captcha_failed", field: "captcha" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
