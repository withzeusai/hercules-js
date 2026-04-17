import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { HerculesAuthProvider } from "./HerculesAuthProvider.js";

vi.mock("react-oidc-context", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  window,
  "localStorage",
);
const originalSessionStorage = Object.getOwnPropertyDescriptor(
  window,
  "sessionStorage",
);

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  }
  if (originalSessionStorage) {
    Object.defineProperty(window, "sessionStorage", originalSessionStorage);
  }
  vi.restoreAllMocks();
});

describe("HerculesAuthProvider", () => {
  it("renders children when localStorage access throws SecurityError", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    expect(() =>
      render(
        <HerculesAuthProvider
          authority="https://example.com"
          client_id="client-id"
        >
          <div>child</div>
        </HerculesAuthProvider>,
      ),
    ).not.toThrow();
  });

  it("renders children when localStorage methods throw SecurityError", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        return {
          setItem() {
            throw new DOMException(
              "The operation is insecure.",
              "SecurityError",
            );
          },
          getItem() {
            return null;
          },
          removeItem() {},
          clear() {},
          key() {
            return null;
          },
          length: 0,
        } as unknown as Storage;
      },
    });

    expect(() =>
      render(
        <HerculesAuthProvider
          authority="https://example.com"
          client_id="client-id"
        >
          <div>child</div>
        </HerculesAuthProvider>,
      ),
    ).not.toThrow();
  });

  it("falls back to sessionStorage when localStorage is blocked", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    const sessionSetItem = vi.fn();
    const sessionRemoveItem = vi.fn();
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        return {
          setItem: sessionSetItem,
          getItem() {
            return null;
          },
          removeItem: sessionRemoveItem,
          clear() {},
          key() {
            return null;
          },
          length: 0,
        } as unknown as Storage;
      },
    });

    render(
      <HerculesAuthProvider
        authority="https://example.com"
        client_id="client-id"
      >
        <div>child</div>
      </HerculesAuthProvider>,
    );

    expect(sessionSetItem).toHaveBeenCalledWith("__hercules_auth_probe__", "1");
    expect(sessionRemoveItem).toHaveBeenCalledWith("__hercules_auth_probe__");
  });

  it("renders children when both localStorage and sessionStorage are blocked", () => {
    const throwSecurityError = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: throwSecurityError,
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: throwSecurityError,
    });

    expect(() =>
      render(
        <HerculesAuthProvider
          authority="https://example.com"
          client_id="client-id"
        >
          <div>child</div>
        </HerculesAuthProvider>,
      ),
    ).not.toThrow();
  });
});
