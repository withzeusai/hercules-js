import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook, act, configure } from "@testing-library/react";
import { ConvexProviderWithHerculesAuth } from "./ConvexProviderWithHercules.js";

configure({ reactStrictMode: true });

const mockSigninSilent = vi.fn();

let mockAuthState: Record<string, unknown> = {};

vi.mock("react-oidc-context", () => ({
  useAuth: () => mockAuthState,
}));

type CapturedUseAuth = () => {
  isLoading: boolean;
  isAuthenticated: boolean;
  fetchAccessToken: (args: {
    forceRefreshToken: boolean;
  }) => Promise<string | null>;
};

let capturedUseAuth: CapturedUseAuth | null = null;

vi.mock("convex/react", () => ({
  ConvexProviderWithAuth: ({
    children,
    useAuth,
  }: {
    children: ReactNode;
    useAuth: CapturedUseAuth;
  }) => {
    capturedUseAuth = useAuth;
    return children;
  },
}));

function setAuthState(overrides: Record<string, unknown>) {
  mockAuthState = {
    isLoading: false,
    isAuthenticated: true,
    user: { id_token: "cached-token" },
    signinSilent: mockSigninSilent,
    ...overrides,
  };
}

beforeEach(() => {
  setAuthState({});
  mockSigninSilent.mockReset();
  capturedUseAuth = null;
});

function renderUseAuth() {
  renderHook(() => null, {
    wrapper: ({ children }) => (
      <ConvexProviderWithHerculesAuth client={{} as never}>
        {children}
      </ConvexProviderWithHerculesAuth>
    ),
  });
  if (!capturedUseAuth) {
    throw new Error("useAuth not captured");
  }
  const captured = capturedUseAuth;
  return renderHook(() => captured());
}

describe("ConvexProviderWithHerculesAuth fetchAccessToken", () => {
  it("returns the cached id token when forceRefreshToken is false", async () => {
    const { result } = renderUseAuth();

    const token = await result.current.fetchAccessToken({
      forceRefreshToken: false,
    });

    expect(token).toBe("cached-token");
    expect(mockSigninSilent).not.toHaveBeenCalled();
  });

  it("calls signinSilent and returns the refreshed token when forceRefreshToken is true", async () => {
    mockSigninSilent.mockResolvedValue({ id_token: "fresh-token" });

    const { result } = renderUseAuth();

    let token: string | null = null;
    await act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(token).toBe("fresh-token");
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("returns null when signinSilent throws", async () => {
    mockSigninSilent.mockRejectedValue(new Error("refresh failed"));

    const { result } = renderUseAuth();

    let token: string | null = "unset";
    await act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(token).toBeNull();
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("returns null when signinSilent resolves without a user", async () => {
    mockSigninSilent.mockResolvedValue(null);

    const { result } = renderUseAuth();

    let token: string | null = "unset";
    await act(async () => {
      token = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(token).toBeNull();
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("dedupes concurrent forceRefreshToken calls into a single signinSilent", async () => {
    let resolveSilent: ((value: { id_token: string }) => void) | null = null;
    mockSigninSilent.mockImplementation(
      () =>
        new Promise<{ id_token: string }>((resolve) => {
          resolveSilent = resolve;
        }),
    );

    const { result } = renderUseAuth();

    let firstToken: string | null = null;
    let secondToken: string | null = null;
    let thirdToken: string | null = null;

    await act(async () => {
      const first = result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
      const second = result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
      const third = result.current.fetchAccessToken({
        forceRefreshToken: true,
      });

      resolveSilent?.({ id_token: "fresh-token" });

      [firstToken, secondToken, thirdToken] = await Promise.all([
        first,
        second,
        third,
      ]);
    });

    expect(firstToken).toBe("fresh-token");
    expect(secondToken).toBe("fresh-token");
    expect(thirdToken).toBe("fresh-token");
    expect(mockSigninSilent).toHaveBeenCalledOnce();
  });

  it("allows a new refresh after the in-flight refresh settles", async () => {
    mockSigninSilent
      .mockResolvedValueOnce({ id_token: "first-fresh" })
      .mockResolvedValueOnce({ id_token: "second-fresh" });

    const { result } = renderUseAuth();

    let firstToken: string | null = null;
    let secondToken: string | null = null;

    await act(async () => {
      firstToken = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });
    await act(async () => {
      secondToken = await result.current.fetchAccessToken({
        forceRefreshToken: true,
      });
    });

    expect(firstToken).toBe("first-fresh");
    expect(secondToken).toBe("second-fresh");
    expect(mockSigninSilent).toHaveBeenCalledTimes(2);
  });
});
