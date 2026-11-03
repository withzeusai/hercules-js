import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, waitFor } from "@testing-library/react";
import { ErrorResponse, UserManager } from "oidc-client-ts";
import { useAuth as useOidcAuth } from "react-oidc-context";
import { HerculesAuthProvider } from "../react/HerculesAuthProvider.js";
import { ConvexProviderWithHerculesAuth } from "./ConvexProviderWithHercules.js";

type ConvexAuth = {
  isLoading: boolean;
  fetchAccessToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>;
};

let convexAuth: ConvexAuth | null = null;
let oidcError: unknown;

vi.mock("convex/react", () => ({
  ConvexProviderWithAuth: ({
    children,
    useAuth,
  }: {
    children: ReactNode;
    useAuth: () => ConvexAuth;
  }) => {
    convexAuth = useAuth();
    return children;
  },
}));

function OidcErrorProbe() {
  oidcError = useOidcAuth().error;
  return null;
}

async function renderWithRealOidc() {
  render(
    <HerculesAuthProvider authority="https://auth.example.com" client_id="test-client">
      <ConvexProviderWithHerculesAuth client={{} as never}>
        <OidcErrorProbe />
      </ConvexProviderWithHerculesAuth>
    </HerculesAuthProvider>,
  );
  await waitFor(() => expect(convexAuth?.isLoading).toBe(false));
  return convexAuth!;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  convexAuth = null;
  oidcError = undefined;
});

// Goes through react-oidc-context's real provider, whose signinSilent resolves
// null on failure instead of throwing.
describe("ConvexProviderWithHerculesAuth with the real react-oidc-context provider", () => {
  it("retries a network failure and returns the refreshed token", async () => {
    const signinSilent = vi
      .spyOn(UserManager.prototype, "signinSilent")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ id_token: "fresh-token" } as never);
    const auth = await renderWithRealOidc();
    vi.useFakeTimers();

    const token = auth.fetchAccessToken({ forceRefreshToken: true });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await token).toBe("fresh-token");
    expect(signinSilent).toHaveBeenCalledTimes(2);
  });

  it("returns null on invalid_grant at once and records the error in auth state", async () => {
    const signinSilent = vi
      .spyOn(UserManager.prototype, "signinSilent")
      .mockRejectedValue(new ErrorResponse({ error: "invalid_grant" }));
    const auth = await renderWithRealOidc();

    expect(await auth.fetchAccessToken({ forceRefreshToken: true })).toBeNull();
    expect(signinSilent).toHaveBeenCalledOnce();
    await waitFor(() => expect(oidcError).toMatchObject({ message: "invalid_grant" }));
  });
});
