import { render, screen } from "@testing-library/react";
import type { UserManager } from "oidc-client-ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerculesAuthProvider, useHerculesAuthProvider } from "./HerculesAuthProvider";

function blockStorage(name: "localStorage" | "sessionStorage") {
  vi.spyOn(window, name, "get").mockImplementation(() => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  });
}

function mountProvider(): UserManager {
  let manager: UserManager | undefined;
  function Capture() {
    manager = useHerculesAuthProvider().userManager;
    return <div data-testid="app">app</div>;
  }
  const { unmount } = render(
    <HerculesAuthProvider authority="https://auth.example.com" client_id="test-client">
      <Capture />
    </HerculesAuthProvider>,
  );
  expect(screen.getByTestId("app")).toBeTruthy();
  unmount();
  return manager!;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HerculesAuthProvider storage", () => {
  it("keeps OIDC state in localStorage when it is available", async () => {
    const { stateStore, userStore } = mountProvider().settings;

    await stateStore.set("request", "state");
    await userStore.set("user", "session");

    expect(window.localStorage.getItem("oidc.request")).toBe("state");
    expect(window.localStorage.getItem("oidc.user")).toBe("session");
  });

  it("falls back to sessionStorage, which survives the sign-in redirect", async () => {
    blockStorage("localStorage");

    await mountProvider().settings.stateStore.set("request", "state");

    expect(window.sessionStorage.getItem("oidc.request")).toBe("state");
    await expect(mountProvider().settings.stateStore.get("request")).resolves.toBe("state");
  });

  it("mounts with in-memory storage when the browser blocks all Web Storage", async () => {
    blockStorage("localStorage");
    blockStorage("sessionStorage");

    const { stateStore } = mountProvider().settings;
    await stateStore.set("request", "state");

    await expect(stateStore.get("request")).resolves.toBe("state");
  });
});
