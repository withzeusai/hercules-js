import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { OidcClient, UserManager, WebStorageStateStore } from "oidc-client-ts";
import { HerculesAuthProvider, useHerculesAuthProvider } from "./HerculesAuthProvider";

// Unlike the provider's recovery tests, these exercise the real OIDC constructor.
const storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage")!;
const selfDescriptor = Object.getOwnPropertyDescriptor(window, "self")!;
let manager: UserManager | undefined;

function Child() {
  manager = useHerculesAuthProvider().userManager;
  return <div>App content</div>;
}

function renderProvider(settings?: Partial<UserManager["settings"]>) {
  return render(
    <HerculesAuthProvider
      authority="https://auth.example.com"
      client_id="test-client"
      userManagerSettings={settings}
    >
      <Child />
    </HerculesAuthProvider>,
  );
}

function denyStorage(
  error: Error = new DOMException("The operation is insecure.", "SecurityError"),
) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw error;
    },
  });
}

beforeEach(() => {
  manager = undefined;
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "localStorage", storageDescriptor);
  Object.defineProperty(window, "self", selfDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("HerculesAuthProvider storage denial", () => {
  it("shows an actionable error without mounting auth or app children", () => {
    const redirect = vi.spyOn(UserManager.prototype, "signinRedirect");
    const reload = vi.fn();
    vi.stubGlobal("location", {
      origin: window.location.origin,
      protocol: window.location.protocol,
      reload,
    });
    denyStorage();
    renderProvider();
    expect(screen.getByRole("alert").textContent).toContain("Browser storage is unavailable");
    expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
    expect(screen.queryByText("App content")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(manager).toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("also handles the default OIDC state store when a custom user store is supplied", () => {
    const userStore = new WebStorageStateStore({ store: window.localStorage });
    denyStorage();
    renderProvider({ userStore });
    expect(screen.getByRole("alert")).toBeDefined();
    expect(manager).toBeUndefined();
  });

  it("preserves explicitly supplied user and state stores", async () => {
    const userStore = new WebStorageStateStore({ store: window.localStorage });
    const stateStore = new WebStorageStateStore({ store: window.localStorage, prefix: "state." });
    denyStorage();
    renderProvider({ userStore, stateStore });
    await waitFor(() => expect(screen.getByText("App content")).toBeDefined());
    expect(manager!.settings.userStore).toBe(userStore);
    expect(manager!.settings.stateStore).toBe(stateStore);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not hide unrelated constructor errors", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Unrelated initialization failure");
    denyStorage(error);
    expect(() => renderProvider()).toThrow(error);
  });

  it("does not forward callback or impersonation credentials to the new tab", () => {
    window.history.replaceState(
      {},
      "",
      "/auth/callback?code=secret&state=state&hercules_impersonation_token=secret#id_token=secret",
    );
    Object.defineProperty(window, "self", { configurable: true, value: {} });
    denyStorage();
    renderProvider();
    const link = screen.getByRole("link", { name: "Open app in a new tab" });
    expect(link.getAttribute("href")).toBe(window.location.origin);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not offer an invalid new-tab entry point for an opaque origin", () => {
    Object.defineProperty(window, "self", { configurable: true, value: {} });
    vi.stubGlobal("location", { origin: "null", protocol: "about:" });
    denyStorage();
    renderProvider();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("retains state, nonce and PKCE across a fresh OIDC client with normal storage", async () => {
    vi.stubGlobal("crypto", webcrypto);
    await act(async () => {
      renderProvider({
        metadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
        },
      });
    });
    const client = new OidcClient(manager!.settings);
    const request = await client.createSigninRequest({
      nonce: "test-nonce",
      state: { returnTo: "/scientists" },
    });
    const state = request.state;
    expect(state.code_verifier).toBeTruthy();
    expect(new URL(request.url).searchParams.get("code_challenge_method")).toBe("S256");
    const restored = await new OidcClient(manager!.settings).readSigninResponseState(
      `${window.location.origin}/auth/callback?code=test-code&state=${state.id}`,
    );
    expect(restored.state.code_verifier).toBe(state.code_verifier);
    expect(restored.state.nonce).toBe("test-nonce");
    expect(restored.state.data).toEqual({ returnTo: "/scientists" });
  });
});
