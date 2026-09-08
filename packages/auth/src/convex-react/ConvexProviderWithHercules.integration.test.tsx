import React, { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { Authenticated, ConvexReactClient, useConvexAuth } from "convex/react";
import { useAuth } from "react-oidc-context";
import {
  User,
  UserManager,
  WebStorageStateStore,
  type SilentRenewErrorCallback,
} from "oidc-client-ts";
import { HerculesAuthProvider, useHerculesAuthProvider } from "../react/HerculesAuthProvider";
import { useAuth as useHerculesAuth, useAuthCallback } from "../react";
import { withRefreshLock } from "../internal/refresh-lock";
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

function SilentRenewErrorListener({ listener }: { listener?: SilentRenewErrorCallback }) {
  const { events } = useAuth();
  useEffect(() => {
    if (!listener) return;
    return events.addSilentRenewError(listener);
  }, [events, listener]);
  return null;
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

async function setup(
  expiresIn = 3600,
  errorListener?: SilentRenewErrorCallback,
  callbackBackendAuthenticated?: boolean,
) {
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
  const refresh = vi.fn().mockImplementation(async () => successfulRenewal());
  vi.stubGlobal("fetch", refresh);
  const hook = renderHook(
    () => {
      const provider = useHerculesAuthProvider();
      manager = provider.userManager;
      const oidc = useAuth();
      const hercules = useHerculesAuth();
      const convex = useConvexAuth();
      const callback = useAuthCallback({
        isBackendAuthenticated: callbackBackendAuthenticated ?? convex.isAuthenticated,
      });
      return { oidc, hercules, convex, callback, provider };
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
          <SilentRenewErrorListener listener={errorListener} />
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

function successfulRenewal(expiresIn = 3600) {
  const fresh = makeToken(expiresIn);
  return Response.json({
    id_token: fresh.token,
    access_token: "new-access",
    refresh_token: "new-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  });
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
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        await waitFor(() => expect(result.current.oidc.error?.message).toBe("invalid_grant"));
        await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(false));
        expect(TestSocket.messages.some((message) => message.tokenType === "None")).toBe(true);
        expect(result.current.oidc.error?.message).toBe("invalid_grant");
        expect(listener).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledOnce();
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

  it.each(["pending", "rejected"] as const)(
    "reports invalid_grant past an early %s listener",
    async (listenerState) => {
      let releaseListener!: () => void;
      const listenerFinished = new Promise<void>((resolve) => {
        releaseListener = resolve;
      });
      const listener = vi.fn(async () => {
        if (listenerState === "rejected") throw new Error("early listener failed");
        await listenerFinished;
      });
      const { result, refresh } = await setup(3600, listener);
      refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));

      try {
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(false));
        expect(TestSocket.messages.some((message) => message.tokenType === "None")).toBe(true);
        expect(result.current.oidc.error?.message).toBe("invalid_grant");
        expect(result.current.hercules.error).toBe(result.current.oidc.error);
        expect(result.current.oidc.error?.innerError).toMatchObject({ error: "invalid_grant" });
        expect(result.current.oidc.error?.source).toBe("signinSilent");
        expect(listener).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        await act(async () => releaseListener());
      }
    },
  );

  it("reports the callback error without waiting for an early pending listener", async () => {
    let releaseListener!: () => void;
    const listenerFinished = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    const listener = vi.fn(() => listenerFinished);
    const { result, refresh } = await setup(-1, listener);
    refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));

    try {
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      await act(async () => {});
      expect(result.current.convex.isAuthenticated).toBe(false);
      expect(result.current.callback.status).toBe("error");
      expect(result.current.callback.error).toBe("invalid_grant");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      await act(async () => releaseListener());
    }
  });

  it("does not publish an old error after a later successful renewal", async () => {
    let releaseListener!: () => void;
    const listenerFinished = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    const listener = vi.fn(() => listenerFinished);
    const { result, refresh } = await setup(3600, listener);
    refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));

    try {
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(false));
      refresh.mockResolvedValueOnce(successfulRenewal(7200));
      await act(async () => {
        await result.current.oidc.signinSilent();
      });
      await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
      expect(result.current.oidc.error).toBeUndefined();
      await act(async () => releaseListener());
      expect(result.current.oidc.error).toBeUndefined();
      expect(result.current.hercules.error).toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => releaseListener());
    }
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

describe("ordered renewal error transitions", () => {
  it.each([false, true])(
    "retains a later invalid_grant after success (prior upstream error: %s)",
    async (priorError) => {
      const { result, refresh, setAuth } = await setup();
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
      await act(async () => {});
      if (priorError) {
        refresh.mockResolvedValueOnce(Response.json({ error: "access_denied" }, { status: 400 }));
        await act(async () => {
          expect(await result.current.oidc.signinSilent()).toBeNull();
        });
        expect(result.current.oidc.error?.message).toBe("access_denied");
      }
      const before = result.current.oidc.user;
      const fetchAccessToken = setAuth.mock.calls[0]![0];
      refresh.mockResolvedValueOnce(successfulRenewal(1800));
      refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
      await act(async () => {
        const successfulUser = await result.current.oidc.signinSilent();
        expect(successfulUser).not.toBeNull();
        // The failing request starts only after the previous request has fully succeeded.
        expect(await fetchAccessToken({ forceRefreshToken: true })).toBeNull();
        expect(await withRefreshLock(async () => "released")).toBe("released");
      });
      expect(refresh).toHaveBeenCalledTimes(priorError ? 4 : 3);
      expect(result.current.oidc.user).not.toBe(before);
      expect(result.current.oidc.error?.message).toBe("invalid_grant");
      expect(result.current.oidc.error?.innerError).toMatchObject({ error: "invalid_grant" });
      expect(result.current.hercules.error).toBe(result.current.oidc.error);
    },
  );

  it("retains a non-fallback error after UserLoaded in the same Convex renewal", async () => {
    const { result, refresh, setAuth } = await setup();
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    await act(async () => {});
    const before = result.current.oidc.user;
    const cause = new Error("application user-loaded observer failed");
    const observer = vi.fn(() => {
      throw cause;
    });
    const remove = manager!.events.addUserLoaded(observer);
    const fetchAccessToken = setAuth.mock.calls[0]![0];
    refresh.mockResolvedValueOnce(successfulRenewal(7200));
    try {
      await act(async () => {
        expect(await fetchAccessToken({ forceRefreshToken: true })).toBeNull();
        expect(await withRefreshLock(async () => "released")).toBe("released");
      });
      expect(observer).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(result.current.oidc.user).not.toBe(before);
      expect(result.current.oidc.user?.profile.sub).toBe(before?.profile.sub);
      expect(result.current.oidc.error?.message).toBe(cause.message);
      expect(result.current.oidc.error?.innerError).toBe(cause);
      expect(result.current.hercules.error).toBe(result.current.oidc.error);
    } finally {
      remove();
    }
  });

  it("retains the same UserLoaded failure on the ordinary public navigator", async () => {
    const { result, refresh } = await setup();
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    await act(async () => {});
    const cause = new Error("ordinary user-loaded observer failed");
    const remove = manager!.events.addUserLoaded(() => {
      throw cause;
    });
    refresh.mockResolvedValueOnce(successfulRenewal(7200));
    try {
      await act(async () => {
        expect(await result.current.oidc.signinSilent()).toBeNull();
      });
      expect(result.current.oidc.error?.message).toBe(cause.message);
      expect(result.current.oidc.error?.innerError).toBe(cause);
      expect(result.current.oidc.error?.source).toBe("signinSilent");
      expect(result.current.hercules.error).toBe(result.current.oidc.error);
    } finally {
      remove();
    }
  });

  it("retains a UserLoaded failure when the real Convex client requests renewal", async () => {
    const { result, refresh } = await setup();
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    await act(async () => {});
    const cause = new Error("backend-triggered renewal observer failed");
    const observer = vi.fn(() => {
      throw cause;
    });
    const remove = manager!.events.addUserLoaded(observer);
    refresh.mockResolvedValueOnce(successfulRenewal(7200));
    try {
      await act(async () => {
        TestSocket.instances.at(-1)!.reject();
      });
      await waitFor(() => expect(observer).toHaveBeenCalledOnce());
      await act(async () => {});
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(result.current.oidc.error?.message).toBe(cause.message);
      expect(result.current.oidc.error?.innerError).toBe(cause);
      expect(result.current.hercules.error).toBe(result.current.oidc.error);
    } finally {
      remove();
    }
  });

  it("clears an earlier raw failure when a later renewal succeeds in the same batch", async () => {
    const { result, refresh, setAuth } = await setup();
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    const fetchAccessToken = setAuth.mock.calls[0]![0];
    refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    refresh.mockResolvedValueOnce(successfulRenewal(7200));

    await act(async () => {
      expect(await fetchAccessToken({ forceRefreshToken: true })).toBeNull();
      expect(await result.current.oidc.signinSilent()).not.toBeNull();
    });

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(result.current.oidc.error).toBeUndefined();
    expect(result.current.hercules.error).toBeUndefined();
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    expect(result.current.oidc.error).toBeUndefined();
  });

  it("keeps a later canonical navigator error over an earlier raw failure in the same batch", async () => {
    const { result, refresh, setAuth } = await setup();
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    const fetchAccessToken = setAuth.mock.calls[0]![0];
    refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    refresh.mockResolvedValueOnce(Response.json({ error: "access_denied" }, { status: 400 }));

    await act(async () => {
      expect(await fetchAccessToken({ forceRefreshToken: true })).toBeNull();
      expect(await result.current.oidc.signinSilent()).toBeNull();
    });

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(result.current.oidc.error?.message).toBe("access_denied");
    expect(result.current.oidc.error?.innerError).toMatchObject({ error: "access_denied" });
    expect(result.current.hercules.error).toBe(result.current.oidc.error);
  });

  it("reports the UserLoaded failure through the public callback hook", async () => {
    const { result, refresh } = await setup(-1);
    const cause = new Error("callback renewal observer failed");
    const remove = manager!.events.addUserLoaded(() => {
      throw cause;
    });
    refresh.mockResolvedValueOnce(successfulRenewal(7200));
    try {
      await waitFor(() => expect(result.current.callback.status).toBe("error"));
      expect(result.current.callback.error).toBe(cause.message);
      expect(result.current.oidc.error?.innerError).toBe(cause);
      expect(result.current.hercules.error).toBe(result.current.oidc.error);
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      remove();
    }
  });
});

describe("ordered provider error reporting", () => {
  it("retains a newer raw failure after a canonical failure without exposing an intermediate callback error", async () => {
    const { result, refresh, setAuth } = await setup(3600, undefined, false);
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    const fetchAccessToken = setAuth.mock.calls[0]![0];
    refresh.mockResolvedValueOnce(Response.json({ error: "access_denied" }, { status: 400 }));
    refresh.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));
    await act(async () => {
      expect(await result.current.oidc.signinSilent()).toBeNull();
      expect(await fetchAccessToken({ forceRefreshToken: true })).toBeNull();
    });
    expect(result.current.oidc.error?.message).toBe("invalid_grant");
    expect(result.current.hercules.error).toBe(result.current.oidc.error);
    expect(result.current.callback.error).toBe("invalid_grant");
  });

  it("retains the original error shape and clears it on a later user load", async () => {
    const { result } = await setup(7200);
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    const report = result.current.provider.reportSigninSilentError;
    const cause = { name: "OAuthFailure", message: "invalid_grant", stack: "original stack" };
    act(() => report(cause));
    expect(result.current.oidc.error).toMatchObject({
      ...cause,
      source: "signinSilent",
      args: undefined,
    });
    expect(result.current.oidc.error?.innerError).toBe(cause);
    expect(String(result.current.oidc.error)).toBe("OAuthFailure: invalid_grant");
    await act(async () => {
      await result.current.oidc.signinSilent();
    });
    expect(result.current.oidc.error).toBeUndefined();
    expect(result.current.provider.reportSigninSilentError).toBe(report);
  });

  it("normalizes a non-object failure without losing its cause", async () => {
    const { result } = await setup(7200);
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    const cause = Symbol("unexpected failure");
    act(() => result.current.provider.reportSigninSilentError(cause));
    expect(result.current.oidc.error?.innerError).toBe(cause);
    expect(result.current.oidc.error?.message).toBe(
      "Unknown error while executing signinSilent(...).",
    );
  });

  it("does not close an in-progress navigator when an adapter reports an error", async () => {
    const { result, refresh } = await setup(7200);
    await waitFor(() => expect(result.current.convex.isAuthenticated).toBe(true));
    let release!: (response: Response) => void;
    refresh.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const navigate = result.current.oidc.signinSilent;
    let pending!: ReturnType<typeof navigate>;
    act(() => {
      pending = navigate();
    });
    await waitFor(() => expect(release).toBeDefined());
    act(() => result.current.provider.reportSigninSilentError(new Error("adapter failed")));
    expect(result.current.oidc.isLoading).toBe(true);
    expect(result.current.oidc.activeNavigator).toBe("signinSilent");
    expect(result.current.oidc.error?.message).toBe("adapter failed");
    expect(result.current.oidc.signinSilent).toBe(navigate);
    await act(async () => {
      release(successfulRenewal());
      await pending;
    });
    expect(result.current.oidc.isLoading).toBe(false);
    expect(result.current.oidc.activeNavigator).toBeUndefined();
    expect(result.current.oidc.error).toBeUndefined();
  });
});
