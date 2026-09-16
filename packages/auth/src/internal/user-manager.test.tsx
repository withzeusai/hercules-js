import { act, renderHook, waitFor } from "@testing-library/react";
import {
  InMemoryWebStorage,
  User,
  UserManager,
  WebStorageStateStore,
  type NavigateParams,
  type UserManagerSettings,
} from "oidc-client-ts";
import { AuthProvider, useAuth } from "react-oidc-context";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerculesUserManager } from "./user-manager";

const AUTHORITY = "https://tenant.hercules-auth.com";
const END_SESSION = "https://auth.example.com/api/auth/oauth2/end-session";
const CLIENT_ID = "configured-client";
const RETURN_URI = "https://app.example.com";
const managers: UserManager[] = [];

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.synthetic-signature`;
}

function user(idToken?: string, profile: Record<string, unknown> = {}): User {
  const now = Math.floor(Date.now() / 1000);
  return new User({
    id_token: idToken,
    access_token: "opaque-access-token",
    refresh_token: "opaque-refresh-token",
    token_type: "Bearer",
    scope: "openid offline_access",
    expires_at: now + 3600,
    profile: {
      iss: AUTHORITY,
      aud: CLIENT_ID,
      sub: "end-user",
      iat: now,
      exp: now + 3600,
      ...profile,
    },
  });
}

function fixture(
  settings: Partial<UserManagerSettings> = {},
  Manager: typeof UserManager = HerculesUserManager,
) {
  const events: string[] = [];
  const navigate = vi.fn(async (params: NavigateParams) => {
    events.push("navigate");
    return { url: params.url };
  });
  const close = vi.fn();
  const navigator = {
    prepare: vi.fn(async () => ({ navigate, close })),
    callback: vi.fn(async () => {}),
  };
  const manager = new Manager(
    {
      authority: AUTHORITY,
      client_id: CLIENT_ID,
      redirect_uri: `${RETURN_URI}/auth/callback`,
      post_logout_redirect_uri: RETURN_URI,
      automaticSilentRenew: false,
      userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
      stateStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
      metadata: {
        issuer: AUTHORITY,
        authorization_endpoint: `${AUTHORITY}/api/auth/oauth2/authorize`,
        end_session_endpoint: END_SESSION,
        revocation_endpoint: `${AUTHORITY}/api/auth/oauth2/revoke`,
      },
      ...settings,
    },
    navigator,
    navigator,
    navigator,
  );
  manager.events.addUserUnloaded(() => {
    events.push("unloaded");
  });
  managers.push(manager);
  return { manager, navigate, close, events };
}

function navigationUrl(navigate: ReturnType<typeof fixture>["navigate"]): URL {
  const params = navigate.mock.calls[0]?.[0];
  expect(params).toBeDefined();
  return new URL(params!.url);
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    manager.stopSilentRenew();
    await manager.events.unload();
  }
  vi.unstubAllGlobals();
});

describe("HerculesUserManager signoutRedirect", () => {
  it.each([
    { name: "missing", sid: undefined },
    { name: "null", sid: null },
    { name: "empty", sid: "" },
    { name: "numeric", sid: 0 },
    { name: "boolean", sid: false },
    { name: "an array", sid: [] },
    { name: "an object", sid: {} },
  ])("uses confirmation when the literal ID-token sid is $name", async ({ sid }) => {
    const { manager, navigate, events } = fixture();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await manager.storeUser(user(token({ sid }), { sid: "profile-is-not-the-ID-token" }));

    await manager.signoutRedirect();

    const url = navigationUrl(navigate);
    expect(url.origin + url.pathname).toBe(END_SESSION);
    expect(url.searchParams.has("id_token_hint")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(RETURN_URI);
    expect(await manager.getUser()).toBeNull();
    expect(events).toEqual(["unloaded", "navigate"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses configured routing instead of claims in the omitted hint", async () => {
    const { manager, navigate } = fixture();
    await manager.storeUser(
      user(token({ sid: null, iss: "https://untrusted.example.com", aud: "another-client" })),
    );

    await manager.signoutRedirect();

    const url = navigationUrl(navigate);
    expect(url.origin + url.pathname).toBe(END_SESSION);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("includes the configured client even without a return URI", async () => {
    const { manager, navigate } = fixture({ post_logout_redirect_uri: "" });
    await manager.storeUser(user(token({ sid: null })));

    await manager.signoutRedirect();

    const url = navigationUrl(navigate);
    expect(url.searchParams.has("post_logout_redirect_uri")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it.each([
    {
      name: "a session-bound token whose profile omits sid",
      idToken: token({ sid: "session-id" }),
      extraQueryParams: {},
    },
    { name: "an unreadable token", idToken: "not-a-jwt", extraQueryParams: {} },
    { name: "no ID token", idToken: undefined, extraQueryParams: {} },
    {
      name: "duplicate hints",
      idToken: token({ sid: null }),
      extraQueryParams: { id_token_hint: token({ sid: null }) },
    },
    {
      name: "a different explicit client",
      idToken: token({ sid: null }),
      extraQueryParams: { client_id: "another-client" },
    },
  ])("keeps the upstream URL byte-for-byte for $name", async ({ idToken, extraQueryParams }) => {
    const original = fixture({ extraQueryParams }, UserManager);
    const adapted = fixture({ extraQueryParams });
    await original.manager.storeUser(user(idToken));
    await adapted.manager.storeUser(user(idToken));

    await original.manager.signoutRedirect();
    await adapted.manager.signoutRedirect();

    expect(adapted.navigate.mock.calls[0]?.[0]).toEqual(original.navigate.mock.calls[0]?.[0]);
    expect(adapted.events).toEqual(original.events);
  });

  it("leaves duplicate client IDs to existing provider validation", async () => {
    const settings = {
      metadata: {
        issuer: AUTHORITY,
        end_session_endpoint: `${END_SESSION}?client_id=${CLIENT_ID}`,
      },
      extraQueryParams: { client_id: CLIENT_ID },
    };
    const original = fixture(settings, UserManager);
    const adapted = fixture(settings);
    await original.manager.storeUser(user(token({ sid: null })));
    await adapted.manager.storeUser(user(token({ sid: null })));

    await original.manager.signoutRedirect();
    await adapted.manager.signoutRedirect();

    expect(adapted.navigate.mock.calls[0]?.[0]).toEqual(original.navigate.mock.calls[0]?.[0]);
  });

  it.each(["signoutPopup", "signoutSilent"] as const)("does not change %s", async (method) => {
    const { manager, navigate } = fixture();
    const idToken = token({ sid: null });
    await manager.storeUser(user(idToken));

    await manager[method]();

    expect(navigationUrl(navigate).searchParams.get("id_token_hint")).toBe(idToken);
  });

  it("does not replace an explicitly supplied session-bound hint", async () => {
    const { manager, navigate } = fixture();
    const supplied = token({ sid: "explicit-session" });
    await manager.storeUser(user(token({ sid: null })));

    await manager.signoutRedirect({ id_token_hint: supplied });

    expect(navigationUrl(navigate).searchParams.get("id_token_hint")).toBe(supplied);
  });

  it("preserves state storage, callback data, and navigator parameters", async () => {
    const { manager, navigate } = fixture({ iframeScriptOrigin: "https://bridge.example.com" });
    await manager.storeUser(user(token({ sid: null })));

    await manager.signoutRedirect({ state: { returnTo: "/settings" }, url_state: "client-state" });

    const url = navigationUrl(navigate);
    const state = url.searchParams.get("state");
    expect(state).toContain("client-state");
    expect(navigate.mock.calls[0]?.[0].scriptOrigin).toBe("https://bridge.example.com");
    const callback = await manager.signoutRedirectCallback(
      `${RETURN_URI}?state=${encodeURIComponent(state!)}`,
    );
    expect(callback.userState).toEqual({ returnTo: "/settings" });
  });

  it.each([
    { types: undefined, expected: ["access_token", "refresh_token"] },
    { types: ["refresh_token"] as const, expected: ["refresh_token"] },
  ])("preserves configured revocation order: $expected", async ({ types, expected }) => {
    const { manager, navigate, events } = fixture({
      revokeTokensOnSignout: true,
      ...(types ? { revokeTokenTypes: [...types] } : {}),
    });
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      events.push(`revoke:${body.get("token_type_hint")}`);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    await manager.storeUser(user(token({ sid: null })));

    await manager.signoutRedirect();

    expect(events).toEqual([...expected.map((type) => `revoke:${type}`), "unloaded", "navigate"]);
    expect(navigationUrl(navigate).searchParams.has("id_token_hint")).toBe(false);
  });

  it("does not reread a user written after the upstream removal", async () => {
    const { manager, navigate, events } = fixture();
    await manager.storeUser(user(token({ sid: null })));
    const readUser = vi.spyOn(manager.settings.userStore, "get");
    manager.events.addUserUnloaded(async () => {
      await manager.storeUser(user(token({ sid: null, iat: 2 })));
    });

    await manager.signoutRedirect();

    expect(readUser).toHaveBeenCalledOnce();
    expect(events).toEqual(["unloaded", "navigate"]);
    expect(navigationUrl(navigate).searchParams.has("id_token_hint")).toBe(false);
  });

  it("delegates navigator failure and close to the upstream error path", async () => {
    const { manager, navigate, close, events } = fixture();
    const error = new Error("navigation failed");
    navigate.mockRejectedValueOnce(error);
    await manager.storeUser(user(token({ sid: null })));

    await expect(manager.signoutRedirect()).rejects.toThrow(error);

    expect(close).toHaveBeenCalledOnce();
    expect(events).toEqual(["unloaded"]);
  });

  it("leaves loading and revocation errors inside the existing React navigator action", async () => {
    const { manager, navigate, close, events } = fixture({ revokeTokensOnSignout: true });
    let rejectRevocation!: (error: Error) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectRevocation = reject;
          }),
      ),
    );
    await manager.storeUser(user(token({ sid: null })));
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <AuthProvider userManager={manager}>{children}</AuthProvider>
      ),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let signout!: ReturnType<typeof manager.signoutRedirect>;
    act(() => {
      signout = result.current.signoutRedirect();
    });
    await waitFor(() => expect(result.current.activeNavigator).toBe("signoutRedirect"));
    await waitFor(() => expect(rejectRevocation).toBeDefined());
    await act(async () => {
      rejectRevocation(new Error("revocation failed"));
      await signout;
    });

    expect(result.current.activeNavigator).toBeUndefined();
    expect(result.current.error?.source).toBe("signoutRedirect");
    expect(navigate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    expect(await manager.getUser()).not.toBeNull();
  });
});
