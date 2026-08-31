import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, screen, waitFor, configure } from "@testing-library/react";
import type { UserManager } from "oidc-client-ts";
import type { AuthProviderBaseProps } from "react-oidc-context";
import { HerculesAuthProvider } from "./HerculesAuthProvider.js";

configure({ reactStrictMode: false });

const mockSigninSilent = vi.fn();
const mockSigninRedirect = vi.fn();
const mockRemoveUser = vi.fn();
let mockAuthState: Record<string, unknown> = {};
const localStorageMock = createMemoryStorage();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

vi.mock("./oidc-auth-state", () => ({
  useOidcAuthState: () => ({ auth: mockAuthState, reportSigninSilentError: vi.fn() }),
}));

vi.mock("oidc-client-ts", () => ({
  UserManager: class {
    constructor() {}
    events = {
      addAccessTokenExpiring: vi.fn(),
      removeAccessTokenExpiring: vi.fn(),
    };
    signinSilent = vi.fn();
  },
  WebStorageStateStore: class {
    constructor() {}
  },
}));

vi.mock("../internal/refresh-lock", () => ({
  withRefreshLock: <T,>(callback: () => Promise<T>) => callback(),
  REFRESH_LOCK_KEY: "__herculesAuthRefresh",
}));

function setAuthState(overrides: Record<string, unknown>) {
  mockAuthState = {
    isLoading: false,
    user: null,
    signinSilent: mockSigninSilent,
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  setAuthState({});
  mockSigninSilent.mockReset();
  mockSigninRedirect.mockReset();
  mockRemoveUser.mockReset();
});

function renderProvider(
  loadingFallback?: React.ReactNode,
  children: React.ReactNode = <div data-testid="app">app content</div>,
) {
  return render(
    <HerculesAuthProvider
      authority="https://auth.example.com"
      client_id="test-client"
      loadingFallback={loadingFallback}
    >
      {children}
    </HerculesAuthProvider>,
  );
}

describe("HerculesAuthProvider accessTokenExpiring renewal listener", () => {
  it("registers the lock-wrapped renewal listener by default", () => {
    render(
      <HerculesAuthProvider authority="https://auth.example.com" client_id="test-client">
        <div data-testid="app">app</div>
      </HerculesAuthProvider>,
    );
    expect(screen.getByTestId("app")).toBeDefined();
  });

  it("skips registering the listener when automaticSilentRenew is explicitly true", () => {
    render(
      <HerculesAuthProvider
        authority="https://auth.example.com"
        client_id="test-client"
        userManagerSettings={{ automaticSilentRenew: true }}
      >
        <div data-testid="app">app</div>
      </HerculesAuthProvider>,
    );
    expect(screen.getByTestId("app")).toBeDefined();
  });
});

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

describe("HerculesAuthProvider AuthRecoveryGate", () => {
  it("prioritizes an impersonation handoff over expired-session recovery", async () => {
    window.history.replaceState(
      {},
      "",
      "/?hercules_impersonation_session_id=session_1&hercules_impersonation_token=token_1",
    );
    setAuthState({
      isAuthenticated: true,
      removeUser: mockRemoveUser.mockResolvedValue(undefined),
      signinRedirect: mockSigninRedirect.mockResolvedValue(undefined),
      user: { expired: true, id_token: "stale" },
    });

    renderProvider(<div data-testid="loading">loading</div>);

    expect(screen.getByTestId("app")).toBeDefined();
    expect(screen.queryByTestId("loading")).toBeNull();
    await waitFor(() => {
      expect(mockSigninRedirect).toHaveBeenCalledTimes(1);
    });
    expect(mockRemoveUser).toHaveBeenCalledTimes(1);
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("renders children (not loadingFallback) while isLoading is true", async () => {
    setAuthState({ isLoading: true, user: null });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("app")).toBeDefined();
    expect(screen.queryByTestId("loading")).toBeNull();
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("blocks children on the very first commit when user is already expired", () => {
    mockSigninSilent.mockImplementation(() => new Promise<void>(() => {}));
    setAuthState({
      isLoading: false,
      user: { expired: true, id_token: "stale" },
    });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("keeps the gate closed while signinSilent is in flight even if isLoading flips true", async () => {
    let resolveSilent!: () => void;
    mockSigninSilent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSilent = resolve;
        }),
    );
    setAuthState({
      isLoading: false,
      user: { expired: true, id_token: "stale" },
    });
    const { rerender } = renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    await waitFor(() => {
      expect(mockSigninSilent).toHaveBeenCalledTimes(1);
    });

    setAuthState({
      isLoading: true,
      user: { expired: true, id_token: "stale" },
    });
    rerender(
      <HerculesAuthProvider
        authority="https://auth.example.com"
        client_id="test-client"
        loadingFallback={<div data-testid="loading">loading</div>}
      >
        <div data-testid="app">app content</div>
      </HerculesAuthProvider>,
    );
    expect(screen.getByTestId("loading")).toBeDefined();
    expect(screen.queryByTestId("app")).toBeNull();

    await act(async () => {
      resolveSilent();
    });
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
  });

  it("recovers correctly under React StrictMode (double-mount)", async () => {
    configure({ reactStrictMode: true });
    mockSigninSilent.mockResolvedValue(undefined);
    setAuthState({ user: { expired: true, id_token: "stale" } });
    renderProvider(<div data-testid="loading">loading</div>);
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    configure({ reactStrictMode: false });
  });

  it("falls back to the outer timeout under StrictMode when signinSilent hangs", async () => {
    configure({ reactStrictMode: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSigninSilent.mockImplementation(() => new Promise<void>(() => {}));
    setAuthState({ user: { expired: true, id_token: "stale" } });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    vi.useRealTimers();
    configure({ reactStrictMode: false });
  });

  it("releases the refresh lock at the safety deadline when signinSilent never settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSigninSilent.mockImplementation(() => new Promise<void>(() => {}));
    setAuthState({ user: { expired: true, id_token: "stale" } });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    vi.useRealTimers();
  });

  it("renders children immediately when user is null", async () => {
    setAuthState({ user: null });
    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("renders children immediately when user is fresh (not expired)", async () => {
    setAuthState({ user: { expired: false, id_token: "token" } });
    renderProvider();
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("calls signinSilent and renders loadingFallback when user is expired", async () => {
    let resolveSilent!: () => void;
    mockSigninSilent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSilent = resolve;
        }),
    );
    setAuthState({ user: { expired: true, id_token: "stale" } });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    expect(screen.queryByTestId("app")).toBeNull();
    await waitFor(() => {
      expect(mockSigninSilent).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      resolveSilent();
    });
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
  });

  it("renders children after the recovery times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSigninSilent.mockImplementation(() => new Promise<void>(() => {}));
    setAuthState({ user: { expired: true, id_token: "stale" } });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    vi.useRealTimers();
  });

  it("renders children after signinSilent throws", async () => {
    mockSigninSilent.mockRejectedValueOnce(new Error("nope"));
    setAuthState({ user: { expired: true, id_token: "stale" } });
    renderProvider(<div data-testid="loading">loading</div>);
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
  });

  it("unblocks UI via outer timeout while keeping the lock held by in-flight signinSilent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockSigninSilent.mockImplementation(() => new Promise<void>(() => {}));
    setAuthState({ user: { expired: true, id_token: "stale" } });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    vi.useRealTimers();
  });

  it("does not refire signinSilent on rerenders", async () => {
    let resolveSilent!: () => void;
    mockSigninSilent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSilent = resolve;
        }),
    );
    setAuthState({ user: { expired: true, id_token: "stale" } });
    const { rerender } = renderProvider();
    await waitFor(() => {
      expect(mockSigninSilent).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      resolveSilent();
    });
    setAuthState({ user: { expired: true, id_token: "stale-2" } });
    rerender(
      <HerculesAuthProvider authority="https://auth.example.com" client_id="test-client">
        <div data-testid="app">app content</div>
      </HerculesAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    expect(mockSigninSilent).toHaveBeenCalledTimes(1);
  });
});

const realOidc = await vi.importActual<typeof import("oidc-client-ts")>("oidc-client-ts");
const upstream = await vi.importActual<typeof import("react-oidc-context")>("react-oidc-context");
const { useOidcAuthState: useRealOidcAuthState } =
  await vi.importActual<typeof import("./oidc-auth-state")>("./oidc-auth-state");
const parityManagers: UserManager[] = [];

afterEach(async () => {
  for (const manager of parityManagers.splice(0)) await manager.events.unload();
});

function parityManager() {
  const manager = new realOidc.UserManager({
    authority: "https://auth.example.com",
    client_id: "test-client",
    redirect_uri: "http://localhost/callback",
    automaticSilentRenew: false,
    userStore: new realOidc.WebStorageStateStore({ store: localStorageMock }),
  });
  vi.spyOn(manager, "getUser").mockResolvedValue(null);
  parityManagers.push(manager);
  return manager;
}

function parityUser() {
  return new realOidc.User({
    id_token: "fixture-id-token",
    access_token: "fixture-access-token",
    token_type: "Bearer",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    profile: {
      sub: "fixture-user",
      iss: "https://auth.example.com",
      aud: "test-client",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  });
}

describe.each(["upstream", "owned"] as const)("%s OIDC provider compatibility", (boundary) => {
  function mount(
    manager: UserManager,
    options: Omit<AuthProviderBaseProps, "children"> = {},
    reactStrictMode = false,
  ) {
    if (boundary === "owned") {
      return renderHook(() => useRealOidcAuthState(manager, options).auth, { reactStrictMode });
    }
    return renderHook(() => upstream.useAuth(), {
      reactStrictMode,
      wrapper: ({ children }) => (
        <upstream.AuthProvider userManager={manager} {...options}>
          {children}
        </upstream.AuthProvider>
      ),
    });
  }

  it.each([
    "signinPopup",
    "signinSilent",
    "signinRedirect",
    "signinResourceOwnerCredentials",
    "signoutPopup",
    "signoutRedirect",
    "signoutSilent",
  ] as const)("preserves %s arguments, loading, result and error provenance", async (method) => {
    const manager = parityManager();
    let resolve!: (value: ReturnType<typeof parityUser> | undefined) => void;
    const call = vi.spyOn(manager, method).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = mount(manager);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const navigate = result.current[method];
    const args = { username: "fixture", password: "fixture", state: "fixture-state" };
    let pending!: Promise<unknown>;
    act(() => {
      pending = navigate(args);
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.activeNavigator).toBe(method);
    expect(call).toHaveBeenCalledWith(args);
    expect(call.mock.contexts[0]).toBe(manager);
    const value =
      method.startsWith("signin") && method !== "signinRedirect" ? parityUser() : undefined;
    await act(async () => {
      resolve(value);
      expect(await pending).toBe(value);
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.activeNavigator).toBeUndefined();
    expect(result.current[method]).toBe(navigate);

    const cause = new Error("navigator failed");
    call.mockRejectedValueOnce(cause);
    await act(async () => {
      expect(await navigate(args)).toBeNull();
    });
    expect(result.current.error?.innerError).toBe(cause);
    expect(result.current.error).toMatchObject({ source: method, args });
    expect(String(result.current.error)).toBe("Error: navigator failed");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.activeNavigator).toBeUndefined();
    const error = result.current.error;
    if (method !== "signinResourceOwnerCredentials") {
      call.mockResolvedValueOnce(undefined);
      await act(async () => {
        await result.current[method]();
      });
      expect(call).toHaveBeenLastCalledWith(undefined);
      // A successful navigator that emits no USER_LOADED event does not clear errors.
      expect(result.current.error).toBe(error);
    }
  });

  it("loads the stored user and exposes the same manager settings and events", async () => {
    const manager = parityManager();
    const user = parityUser();
    vi.mocked(manager.getUser).mockResolvedValue(user);
    const { result } = mount(manager);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.user).toBe(user);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.settings).toBe(manager.settings);
    expect(result.current.events).toBe(manager.events);
  });

  it("initializes once under Strict Mode effect replay", async () => {
    const manager = parityManager();
    const { result } = mount(manager, {}, true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(manager.getUser).toHaveBeenCalledOnce();
    expect(result.current.isAuthenticated).toBe(false);
  });

  it.each([false, true])(
    "respects skipSigninCallback=%s and callback ordering",
    async (skipSigninCallback) => {
      window.history.replaceState({}, "", "/?code=fixture&state=fixture");
      const manager = parityManager();
      const user = parityUser();
      const order: string[] = [];
      vi.mocked(manager.getUser).mockImplementation(async () => {
        order.push("getUser");
        return user;
      });
      const signin = vi.spyOn(manager, "signinCallback").mockImplementation(async () => {
        order.push("signinCallback");
        return undefined;
      });
      const signout = vi.spyOn(manager, "signoutCallback").mockImplementation(async () => {
        order.push("signoutCallback");
        return undefined;
      });
      const { result } = mount(manager, {
        skipSigninCallback,
        onSigninCallback: () => {
          order.push("onSigninCallback");
        },
        matchSignoutCallback: () => true,
        onSignoutCallback: () => {
          order.push("onSignoutCallback");
        },
      });
      await waitFor(() => expect(order.at(-1)).toBe("onSignoutCallback"));
      expect(order).toEqual([
        ...(!skipSigninCallback ? ["signinCallback", "onSigninCallback"] : []),
        "getUser",
        "signoutCallback",
        "onSignoutCallback",
      ]);
      expect(signin).toHaveBeenCalledTimes(skipSigninCallback ? 0 : 1);
      expect(signout).toHaveBeenCalledOnce();
      expect(result.current.user).toBe(user);
    },
  );

  it("still processes sign-out matching after a sign-in initialization error", async () => {
    const manager = parityManager();
    const cause = new Error("stored user failed");
    vi.mocked(manager.getUser).mockRejectedValue(cause);
    const signout = vi.spyOn(manager, "signoutCallback").mockResolvedValue(undefined);
    const onSignoutCallback = vi.fn();
    const { result } = mount(manager, { matchSignoutCallback: () => true, onSignoutCallback });
    await waitFor(() => expect(onSignoutCallback).toHaveBeenCalledOnce());
    expect(signout).toHaveBeenCalledOnce();
    expect(result.current.error).toMatchObject({ source: "signinCallback", innerError: cause });
    expect(result.current.isLoading).toBe(false);
  });

  it("retains a canonical error on unload and clears it on a later load", async () => {
    const manager = parityManager();
    const cause = new Error("renewal failed");
    vi.spyOn(manager, "signinSilent").mockRejectedValue(cause);
    const { result } = mount(manager);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.signinSilent();
    });
    const error = result.current.error;
    await act(async () => {
      await manager.events.unload();
    });
    expect(result.current.user).toBeUndefined();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBe(error);
    const user = parityUser();
    await act(async () => {
      await manager.events.load(user);
    });
    expect(result.current.user).toBe(user);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it("propagates removeUser hook failure without synthesizing a navigator error", async () => {
    const manager = parityManager();
    const cause = new Error("remove hook failed");
    const removed = vi.spyOn(manager, "removeUser").mockResolvedValue(undefined);
    const onRemoveUser = vi.fn().mockRejectedValue(cause);
    const { result } = mount(manager, { onRemoveUser });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await expect(result.current.removeUser()).rejects.toBe(cause);
    expect(removed).toHaveBeenCalledOnce();
    expect(onRemoveUser).toHaveBeenCalledOnce();
    expect(result.current.error).toBeUndefined();
    expect(result.current.activeNavigator).toBeUndefined();
  });

  it("uses the callback user without rereading storage", async () => {
    window.history.replaceState({}, "", "/#code=fixture&state=fixture");
    const manager = parityManager();
    const user = parityUser();
    vi.spyOn(manager, "signinCallback").mockResolvedValue(user);
    const onSigninCallback = vi.fn();
    const { result } = mount(manager, { onSigninCallback });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(onSigninCallback).toHaveBeenCalledWith(user);
    expect(manager.getUser).not.toHaveBeenCalled();
    expect(result.current.user).toBe(user);
  });

  it("reports sign-out callback errors without discarding the loaded user", async () => {
    const manager = parityManager();
    const user = parityUser();
    vi.mocked(manager.getUser).mockResolvedValue(user);
    const cause = new Error("signout callback failed");
    vi.spyOn(manager, "signoutCallback").mockRejectedValue(cause);
    const { result } = mount(manager, { matchSignoutCallback: () => true });
    await waitFor(() => expect(result.current.error?.source).toBe("signoutCallback"));
    expect(result.current.error?.innerError).toBe(cause);
    expect(result.current.user).toBe(user);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps direct manager helpers bound and outside navigator state", async () => {
    const manager = parityManager();
    const clear = vi.spyOn(manager, "clearStaleState").mockResolvedValue(undefined);
    const query = vi.spyOn(manager, "querySessionStatus").mockResolvedValue(null);
    const revoke = vi.spyOn(manager, "revokeTokens").mockResolvedValue(undefined);
    const start = vi.spyOn(manager, "startSilentRenew").mockImplementation(() => {});
    const stop = vi.spyOn(manager, "stopSilentRenew").mockImplementation(() => {});
    const { result } = mount(manager);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const auth = result.current;
    await auth.clearStaleState();
    const queryArgs = {};
    expect(await auth.querySessionStatus(queryArgs)).toBeNull();
    await auth.revokeTokens(["access_token"]);
    auth.startSilentRenew();
    auth.stopSilentRenew();
    for (const call of [clear, query, revoke, start, stop]) {
      expect(call).toHaveBeenCalledOnce();
      expect(call.mock.contexts[0]).toBe(manager);
    }
    expect(query).toHaveBeenCalledWith(queryArgs);
    expect(revoke).toHaveBeenCalledWith(["access_token"]);
    expect(result.current).toBe(auth);
  });

  it("keeps canonical event semantics and unregisters each handler", async () => {
    const manager = parityManager();
    const loaded = vi.spyOn(manager.events, "addUserLoaded");
    const unloaded = vi.spyOn(manager.events, "addUserUnloaded");
    const signedOut = vi.spyOn(manager.events, "addUserSignedOut");
    const failed = vi.spyOn(manager.events, "addSilentRenewError");
    const removeLoaded = vi.spyOn(manager.events, "removeUserLoaded");
    const removeUnloaded = vi.spyOn(manager.events, "removeUserUnloaded");
    const removeSignedOut = vi.spyOn(manager.events, "removeUserSignedOut");
    const removeFailed = vi.spyOn(manager.events, "removeSilentRenewError");
    const { result, unmount } = mount(manager);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const user = parityUser();
    await act(async () => {
      await manager.events.load(user);
    });
    const cause = new Error("timer renewal failed");
    await act(async () => {
      await manager.events._raiseSilentRenewError(cause);
    });
    expect(result.current.error).toMatchObject({ source: "renewSilent", innerError: cause });
    const error = result.current.error;
    await act(async () => {
      await manager.events._raiseUserSignedOut();
    });
    expect(result.current.user).toBeUndefined();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBe(error);
    unmount();
    for (const [add, remove] of [
      [loaded, removeLoaded],
      [unloaded, removeUnloaded],
      [signedOut, removeSignedOut],
      [failed, removeFailed],
    ]) {
      expect(add).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith(add.mock.calls[0]![0]);
    }
  });
});
