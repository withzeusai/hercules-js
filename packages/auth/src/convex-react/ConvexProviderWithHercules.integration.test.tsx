import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { Authenticated, ConvexReactClient, useConvexAuth } from "convex/react";
import { useAuth } from "react-oidc-context";
import { User, UserManager, WebStorageStateStore } from "oidc-client-ts";
import { HerculesAuthProvider, useHerculesAuthProvider } from "../react/HerculesAuthProvider";
import { ConvexProviderWithHerculesAuth } from "./ConvexProviderWithHercules";

const ISSUER = "https://issuer.example";
let serial = 0;
function makeToken(expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const profile = { iss: ISSUER, sub: "alice", aud: "test", iat: now, exp: now + expiresIn };
  const token = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ ...profile, jti: ++serial }))}.sig`;
  return { token, profile };
}

type AuthMessage = {
  type: "Authenticate";
  tokenType: "User" | "None";
  value?: string;
  baseVersion: number;
};

class TestSocket {
  static instances: TestSocket[] = [];
  static messages: AuthMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror = null;
  readyState = 0;
  identity = 0;
  querySet = 0;

  constructor() {
    TestSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(raw: string) {
    const message = JSON.parse(raw);
    if (message.type === "Authenticate") {
      TestSocket.messages.push(message);
      if (message.tokenType === "User") {
        const claims = JSON.parse(atob(message.value.split(".")[1]));
        if (claims.exp <= Date.now() / 1000) {
          queueMicrotask(() => this.reject(message.baseVersion, true));
          return;
        }
      }
      queueMicrotask(() => this.transition(message.baseVersion + 1, this.querySet));
    }
    if (message.type === "ModifyQuerySet") {
      queueMicrotask(() => this.transition(this.identity, message.newVersion));
    }
  }

  transition(identity: number, querySet: number) {
    const startVersion = { identity: this.identity, querySet: this.querySet, ts: "AAAAAAAAAAA=" };
    this.identity = identity;
    this.querySet = querySet;
    this.receive({
      type: "Transition",
      startVersion,
      endVersion: { identity, querySet, ts: "AAAAAAAAAAA=" },
      modifications: [],
    });
  }

  reject(baseVersion = this.identity, authUpdateAttempted = false) {
    this.receive({
      type: "AuthError",
      baseVersion,
      authUpdateAttempted,
      error: "Token rejected by backend",
    });
  }

  receive(message: unknown) {
    if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
}

function DraftForm() {
  const [draft, setDraft] = useState("");
  return (
    <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
  );
}

let client: ConvexReactClient | undefined;
let manager: UserManager | undefined;
afterEach(async () => {
  cleanup();
  await client?.close();
  manager?.events.unload();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  TestSocket.instances = [];
  TestSocket.messages = [];
});

async function setup(expiresIn = 3600) {
  const initial = makeToken(expiresIn);
  manager = new UserManager({
    authority: ISSUER,
    client_id: "test",
    redirect_uri: "http://localhost/callback",
    automaticSilentRenew: false,
    userStore: new WebStorageStateStore({ store: localStorage }),
    metadata: { issuer: ISSUER, token_endpoint: `${ISSUER}/token` },
  });
  await manager.storeUser(
    new User({
      id_token: initial.token,
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      profile: initial.profile,
    }),
  );
  client = new ConvexReactClient("https://fixture.convex.cloud", {
    webSocketConstructor: TestSocket as unknown as typeof WebSocket,
    unsavedChangesWarning: false,
    logger: false,
  });
  const setAuth = vi.spyOn(client, "setAuth");
  const refresh = vi.fn().mockImplementation(async () => {
    const fresh = makeToken();
    return Response.json({
      id_token: fresh.token,
      access_token: "new-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  vi.stubGlobal("fetch", refresh);
  const hook = renderHook(
    () => {
      manager = useHerculesAuthProvider().userManager;
      return { oidc: useAuth(), convex: useConvexAuth() };
    },
    {
      wrapper: ({ children }) => (
        <HerculesAuthProvider
          authority={ISSUER}
          client_id="test"
          userManagerSettings={{
            metadata: { issuer: ISSUER, token_endpoint: `${ISSUER}/token` },
          }}
        >
          <ConvexProviderWithHerculesAuth client={client!}>
            {children}
            <Authenticated>
              <DraftForm />
            </Authenticated>
          </ConvexProviderWithHerculesAuth>
        </HerculesAuthProvider>
      ),
    },
  );
  return { ...hook, refresh, setAuth };
}

function transientFailure() {
  return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
}

describe("real Convex and OIDC refresh integration", () => {
  it("keeps an authenticated draft through a 503, later renewal, and old-token expiry", async () => {
    const { result, refresh, setAuth } = await setup(30);
    refresh.mockResolvedValueOnce(transientFailure());
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await act(async () => {});

    expect(result.current.oidc.isAuthenticated).toBe(true);
    expect(result.current.convex.isAuthenticated).toBe(true);
    expect(TestSocket.messages.filter((message) => message.tokenType === "None")).toHaveLength(0);

    fireEvent.change(screen.getByRole("textbox", { name: "draft" }), {
      target: { value: "unsaved-phone-order" },
    });
    const draft = screen.getByRole("textbox", { name: "draft" });
    await act(async () => {
      await result.current.oidc.signinSilent();
    });
    expect(setAuth).toHaveBeenCalledOnce();
    expect(result.current.convex.isAuthenticated).toBe(true);
    expect(screen.getByRole("textbox", { name: "draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("unsaved-phone-order");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    await act(async () => {
      TestSocket.instances.at(-1)!.reject();
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    expect(setAuth).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("unsaved-phone-order");
    expect(TestSocket.messages.filter((message) => message.tokenType === "None")).toHaveLength(0);
  });

  it("leaves backend rejection authoritative and recovers after a new valid OIDC token", async () => {
    const { result, refresh, setAuth } = await setup();
    refresh.mockResolvedValueOnce(transientFailure());
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await act(async () => {});
    refresh.mockResolvedValueOnce(transientFailure());
    await act(async () => {
      TestSocket.instances.at(-1)!.reject();
    });
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(false));
    expect(result.current.oidc.isAuthenticated).toBe(true);

    await act(async () => {
      await result.current.oidc.signinSilent();
    });
    await waitFor(() => expect(setAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
  });

  it("stops using a fallback at expiry and reconnects after a later valid renewal", async () => {
    const { result, refresh, setAuth } = await setup();
    refresh.mockResolvedValueOnce(transientFailure());
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601_000);
    refresh.mockResolvedValueOnce(transientFailure());
    await act(async () => {
      TestSocket.instances.at(-1)!.reject();
    });
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(false));
    expect(refresh).toHaveBeenCalledTimes(2);

    await act(async () => {
      await result.current.oidc.signinSilent();
    });
    await waitFor(() => expect(setAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
  });

  it("does not preserve auth on invalid_grant", async () => {
    const { result, refresh } = await setup();
    refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(false));
    expect(TestSocket.messages.some((message) => message.tokenType === "None")).toBe(true);
    expect(result.current.oidc.error?.message).toBe("invalid_grant");
  });

  it.each(["pending", "rejected"] as const)(
    "fails closed when a renewal-error listener is %s",
    async (listenerState) => {
      const { result, refresh } = await setup();
      let releaseListener!: () => void;
      const listenerFinished = new Promise<void>((resolve) => {
        releaseListener = resolve;
      });
      const listener = vi.fn(async () => {
        if (listenerState === "rejected") throw new Error("listener failed");
        await listenerFinished;
      });
      const removeListener = manager!.events.addSilentRenewError(listener);
      refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));

      try {
        await waitFor(() => expect(listener).toHaveBeenCalledOnce());
        await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(false));
        expect(TestSocket.messages.some((message) => message.tokenType === "None")).toBe(true);
        expect(result.current.oidc.error?.message).toBe("invalid_grant");
      } finally {
        await act(async () => releaseListener());
        removeListener();
      }
    },
  );

  it("reports invalid_grant immediately after an expired ID token is rejected", async () => {
    const { result, refresh } = await setup(-1);
    refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await waitFor(() => expect(result.current.oidc.error?.message).toBe("invalid_grant"));
    expect(result.current.convex.isAuthenticated).toBe(false);
    expect(screen.queryByRole("textbox", { name: "draft" })).toBeNull();
  });

  it("refreshes an expired ID token and awaits backend confirmation", async () => {
    const { result, refresh } = await setup(-1);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    expect(result.current.oidc.user?.id_token).toBe(TestSocket.messages.at(-1)?.value);
  });

  it("does not reset Convex for an ordinary successful refresh", async () => {
    const { result, refresh, setAuth } = await setup();
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    expect(setAuth).toHaveBeenCalledOnce();
    await act(async () => {
      await result.current.oidc.signinSilent();
    });
    expect(setAuth).toHaveBeenCalledOnce();
    expect(result.current.convex.isAuthenticated).toBe(true);
  });
});
