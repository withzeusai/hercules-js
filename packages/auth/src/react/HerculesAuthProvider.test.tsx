import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { HerculesAuthProvider } from "./HerculesAuthProvider.js";
import { getSafeStateStore, getSafeUserStore } from "./safe-storage.js";

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

const originalGetCookie = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "cookie",
);

function clearAllCookies() {
  for (const part of document.cookie.split("; ")) {
    const name = part.split("=")[0];
    if (name) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  }
}

function disableCookies() {
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() {
      return "";
    },
    set() {},
  });
}

function restoreCookieDescriptor() {
  if (Object.getOwnPropertyDescriptor(document, "cookie")) {
    delete (document as unknown as { cookie?: unknown }).cookie;
  }
  if (originalGetCookie) {
    Object.defineProperty(Document.prototype, "cookie", originalGetCookie);
  }
}

afterEach(() => {
  restoreStorageDescriptors();
  restoreCookieDescriptor();
  clearAllCookies();
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

  it("falls back to a cookie state store that survives a redirect when both Web Storage APIs throw", async () => {
    throwOnStorageAccess("localStorage");
    throwOnStorageAccess("sessionStorage");

    const stateStore = getSafeStateStore();
    await stateStore.set("state-key", "state-value");

    expect(document.cookie).toContain("oidc.state-key=state-value");
    expect(await stateStore.get("state-key")).toBe("state-value");
    expect(await stateStore.getAllKeys()).toContain("state-key");

    const removed = await stateStore.remove("state-key");
    expect(removed).toBe("state-value");
    expect(await stateStore.get("state-key")).toBeNull();
    expect(document.cookie).not.toContain("oidc.state-key");
  });

  it("mounts and uses the cookie state store when only cookies are available", () => {
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

  it("falls back to in-memory storage when localStorage, sessionStorage, and cookies are all unavailable", async () => {
    throwOnStorageAccess("localStorage");
    throwOnStorageAccess("sessionStorage");
    disableCookies();

    const stateStore = getSafeStateStore();
    await stateStore.set("state-key", "state-value");
    expect(await stateStore.get("state-key")).toBe("state-value");

    expect(() =>
      render(
        <HerculesAuthProvider authority="https://example.test" client_id="abc">
          <div>child</div>
        </HerculesAuthProvider>,
      ),
    ).not.toThrow();
  });

  it("does not clobber host data stored at the probe namespace", () => {
    window.localStorage.clear();
    window.localStorage.setItem("__hercules_auth_storage_probe__", "host-data");

    getSafeUserStore();
    getSafeStateStore();

    expect(window.localStorage.getItem("__hercules_auth_storage_probe__")).toBe(
      "host-data",
    );
    expect(document.cookie).not.toContain("__hercules_auth_cookie_probe__");

    window.localStorage.clear();
  });
});
