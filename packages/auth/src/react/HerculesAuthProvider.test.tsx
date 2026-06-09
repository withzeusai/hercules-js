import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import {
  HerculesAuthProvider,
  getSafeStateStore,
  getSafeUserStore,
} from "./HerculesAuthProvider.js";

vi.mock("react-oidc-context", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="oidc-provider">{children}</div>
  ),
}));

const originalGetLocalStorage = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);
const originalGetSessionStorage = Object.getOwnPropertyDescriptor(
  window,
  "sessionStorage",
);

function restoreStorageDescriptors() {
  if (originalGetLocalStorage) {
    Object.defineProperty(window, "localStorage", originalGetLocalStorage);
  }
  if (originalGetSessionStorage) {
    Object.defineProperty(window, "sessionStorage", originalGetSessionStorage);
  }
}

function throwOnStorageAccess(kind: "localStorage" | "sessionStorage") {
  Object.defineProperty(window, kind, {
    configurable: true,
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });
}

afterEach(() => {
  restoreStorageDescriptors();
});

describe("HerculesAuthProvider storage fallback", () => {
  it("falls back to in-memory storage when both window.localStorage and window.sessionStorage throw", () => {
    throwOnStorageAccess("localStorage");
    throwOnStorageAccess("sessionStorage");

    const userStore = getSafeUserStore();
    const stateStore = getSafeStateStore();

    expect(userStore).toBeDefined();
    expect(stateStore).toBeDefined();
  });

  it("prefers sessionStorage when localStorage throws but sessionStorage works", async () => {
    throwOnStorageAccess("localStorage");
    window.sessionStorage.clear();

    const stateStore = getSafeStateStore();
    await stateStore.set("probe-key", "probe-value");

    expect(window.sessionStorage.getItem("oidc.probe-key")).toBe("probe-value");

    window.sessionStorage.clear();
  });

  it("uses real localStorage when it is available", async () => {
    window.localStorage.clear();

    const stateStore = getSafeStateStore();
    await stateStore.set("probe-key", "probe-value");

    expect(window.localStorage.getItem("oidc.probe-key")).toBe("probe-value");

    window.localStorage.clear();
  });

  it("mounts HerculesAuthProvider without throwing when storage is blocked", () => {
    throwOnStorageAccess("localStorage");
    throwOnStorageAccess("sessionStorage");

    expect(() =>
      render(
        <HerculesAuthProvider authority="https://example.test" client_id="abc">
          <div>child</div>
        </HerculesAuthProvider>,
      ),
    ).not.toThrow();
  });
});
