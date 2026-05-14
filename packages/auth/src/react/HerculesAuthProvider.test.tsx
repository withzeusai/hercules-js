import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, configure } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  HerculesAuthProvider,
  useHerculesAuthProvider,
} from "./HerculesAuthProvider";

configure({ reactStrictMode: true });

// react-oidc-context's AuthProvider does its own work we don't care about
// here. Pass through so we can mount HerculesAuthProvider in isolation
// and inspect what it actually exposes via context.
vi.mock("react-oidc-context", async () => {
  const actual = await vi.importActual<typeof import("react-oidc-context")>(
    "react-oidc-context",
  );
  return {
    ...actual,
    AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

function ProviderProbe({
  onContext,
}: {
  onContext: (ctx: ReturnType<typeof useHerculesAuthProvider>) => void;
}) {
  const ctx = useHerculesAuthProvider();
  onContext(ctx);
  return null;
}

/**
 * Replace `window.localStorage` with a stub. Used to simulate the three
 * pathological modes we care about:
 *   - getter throws (sandboxed iframe / Brave fingerprint defense)
 *   - setItem throws (Safari private mode quota)
 *   - silently drops writes (some extension-injected polyfills)
 */
function installLocalStorage(
  stub: Storage | (() => never),
): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage");
  if (typeof stub === "function") {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: stub,
    });
  } else {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: stub,
    });
  }
  return () => {
    if (original) {
      Object.defineProperty(window, "localStorage", original);
    }
  };
}

beforeEach(() => {
  // jsdom's localStorage starts dirty across files in some runners; clear it
  // so test order can't influence the probe.
  try {
    window.localStorage.clear();
  } catch {
    // ignore — we'll be overriding it in each test anyway
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HerculesAuthProvider storage probe", () => {
  it("reports storageAvailable: true when localStorage works", () => {
    let captured: ReturnType<typeof useHerculesAuthProvider> | undefined;
    render(
      <HerculesAuthProvider
        authority="https://issuer.example.com"
        client_id="client_xyz"
      >
        <ProviderProbe onContext={(c) => (captured = c)} />
      </HerculesAuthProvider>,
    );
    expect(captured?.storageAvailable).toBe(true);
  });

  it("falls back to in-memory store when the localStorage getter throws", () => {
    const restore = installLocalStorage(() => {
      throw new Error("SecurityError");
    });
    try {
      let captured: ReturnType<typeof useHerculesAuthProvider> | undefined;
      render(
        <HerculesAuthProvider
          authority="https://issuer.example.com"
          client_id="client_xyz"
        >
          <ProviderProbe onContext={(c) => (captured = c)} />
        </HerculesAuthProvider>,
      );
      expect(captured?.storageAvailable).toBe(false);
    } finally {
      restore();
    }
  });

  it("falls back when setItem throws (Safari private mode quota)", () => {
    const restore = installLocalStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
    try {
      let captured: ReturnType<typeof useHerculesAuthProvider> | undefined;
      render(
        <HerculesAuthProvider
          authority="https://issuer.example.com"
          client_id="client_xyz"
        >
          <ProviderProbe onContext={(c) => (captured = c)} />
        </HerculesAuthProvider>,
      );
      expect(captured?.storageAvailable).toBe(false);
    } finally {
      restore();
    }
  });

  it("falls back when the store silently drops writes", () => {
    // setItem accepts the call but the value never persists. Without a
    // readback check the probe would mark this as healthy and every
    // callback would later look like missing_oidc_state.
    const restore = installLocalStorage({
      getItem: () => null, // always returns null regardless of setItem
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    });
    try {
      let captured: ReturnType<typeof useHerculesAuthProvider> | undefined;
      render(
        <HerculesAuthProvider
          authority="https://issuer.example.com"
          client_id="client_xyz"
        >
          <ProviderProbe onContext={(c) => (captured = c)} />
        </HerculesAuthProvider>,
      );
      expect(captured?.storageAvailable).toBe(false);
    } finally {
      restore();
    }
  });
});
