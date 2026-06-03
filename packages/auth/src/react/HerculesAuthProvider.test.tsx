import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, configure } from "@testing-library/react";
import { HerculesAuthProvider } from "./HerculesAuthProvider.js";

configure({ reactStrictMode: false });

const mockSigninSilent = vi.fn();
let mockAuthState: Record<string, unknown> = {};

vi.mock("react-oidc-context", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => mockAuthState,
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
  setAuthState({});
  mockSigninSilent.mockReset();
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

describe("HerculesAuthProvider AuthRecoveryGate", () => {
  it("renders children (not loadingFallback) while isLoading is true", async () => {
    setAuthState({ isLoading: true, user: null });
    renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("app")).toBeDefined();
    expect(screen.queryByTestId("loading")).toBeNull();
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("blocks children on the very first commit when user is already expired", () => {
    mockSigninSilent.mockImplementation(() => new Promise<void>(() => {}));
    setAuthState({ isLoading: false, user: { expired: true, id_token: "stale" } });
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
    setAuthState({ isLoading: false, user: { expired: true, id_token: "stale" } });
    const { rerender } = renderProvider(<div data-testid="loading">loading</div>);
    expect(screen.getByTestId("loading")).toBeDefined();
    await waitFor(() => {
      expect(mockSigninSilent).toHaveBeenCalledTimes(1);
    });

    setAuthState({ isLoading: true, user: { expired: true, id_token: "stale" } });
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
      <HerculesAuthProvider
        authority="https://auth.example.com"
        client_id="test-client"
      >
        <div data-testid="app">app content</div>
      </HerculesAuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("app")).toBeDefined();
    });
    expect(mockSigninSilent).toHaveBeenCalledTimes(1);
  });
});
