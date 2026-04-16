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

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
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
});
