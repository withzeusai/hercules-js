import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeSession: vi.fn(async () => {}),
  request: new Request("https://theirapp.com/sign-in", {
    headers: { "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0" },
  }),
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => mocks.request }));
vi.mock("./session-store", () => ({ writeSession: mocks.writeSession }));

const {
  authenticateWithEmailVerificationBody,
  authenticateWithPasswordBody,
  sendPasswordResetEmailBody,
} = await import("./server-api-bodies");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeAll(() => {
  process.env.HERCULES_OIDC_AUTHORITY = "https://tenant.hercules-auth.com";
  process.env.HERCULES_AUTH_API_KEY = "hak_test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.writeSession.mockClear();
});

describe("server-side authentication", () => {
  it("signs in through the server API and seals the session", async () => {
    const fetch = vi.fn(async () =>
      json({
        user: { id: "user_1", email: "a@example.com", email_verified: true, name: "Ada" },
        access_token: "at",
        refresh_token: "rt",
        id_token: "it",
        expires_in: 3600,
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await authenticateWithPasswordBody({ email: "a@example.com", password: "pw" });

    expect(result).toMatchObject({ ok: true, user: { id: "user_1", email: "a@example.com" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tenant.hercules-auth.com/api/server/v1/authenticate");
    expect(init.headers).toMatchObject({ authorization: "Bearer hak_test" });
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: "password",
      email: "a@example.com",
      password: "pw",
      ip_address: "203.0.113.9",
      user_agent: "Mozilla/5.0",
    });
    expect(mocks.writeSession).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "at", refreshToken: "rt", idToken: "it" }),
    );
  });

  it("returns the verification continuation without a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            code: "email_verification_required",
            message: "Verify the email address to continue.",
            email: "a@example.com",
            pending_authentication_token: "pending",
          },
          403,
        ),
      ),
    );

    const result = await authenticateWithPasswordBody({ email: "a@example.com", password: "pw" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "email_verification_required", pendingAuthenticationToken: "pending" },
    });
    expect(mocks.writeSession).not.toHaveBeenCalled();
  });

  it("sends the pending token with the code", async () => {
    const fetch = vi.fn(async () =>
      json({ code: "invalid_pending_authentication_token", message: "Start again" }, 400),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await authenticateWithEmailVerificationBody({
      code: "123456",
      pendingAuthenticationToken: "pending",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_token" } });
    expect(
      JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toMatchObject({
      grant_type: "email_verification",
      code: "123456",
      pending_authentication_token: "pending",
    });
  });

  it("resolves a relative reset path on the app's origin", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    expect(
      await sendPasswordResetEmailBody({
        email: "a@example.com",
        passwordResetUrl: "/reset-password",
      }),
    ).toEqual({ ok: true });
    expect(
      JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toMatchObject({
      password_reset_url: "https://theirapp.com/reset-password",
    });
  });
});
