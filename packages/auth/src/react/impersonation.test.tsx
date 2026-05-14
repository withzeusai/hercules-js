import { renderHook, waitFor, configure } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHerculesImpersonation } from "./impersonation";
import {
  getHerculesImpersonationStorageKey,
  rememberHerculesImpersonationSession,
} from "./impersonation-core";

configure({ reactStrictMode: true });

const storageKey = getHerculesImpersonationStorageKey(
  "https://auth.example.com",
  "client_1",
);
const mockSignoutRedirect = vi.fn();
const mockRemoveUser = vi.fn();
const mockGetEndSessionEndpoint = vi.fn();
const mockUserManager = {
  metadataService: {
    getEndSessionEndpoint: mockGetEndSessionEndpoint,
  },
};

let mockAuthState: Record<string, unknown> = {};
const localStorageMock = createMemoryStorage();

Object.defineProperty(window, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

vi.mock("react-oidc-context", () => ({
  useAuth: () => mockAuthState,
}));

vi.mock("./HerculesAuthProvider", () => ({
  useHerculesAuthProvider: () => ({
    userManager: mockUserManager,
    impersonationStorageKey: storageKey,
  }),
}));

beforeEach(() => {
  window.localStorage.removeItem(storageKey);
  mockSignoutRedirect.mockReset();
  mockRemoveUser.mockReset();
  mockGetEndSessionEndpoint.mockReset();
  mockAuthState = {
    isAuthenticated: true,
    signoutRedirect: mockSignoutRedirect,
    removeUser: mockRemoveUser,
    user: {
      profile: {},
    },
  };
});

describe("useHerculesImpersonation", () => {
  it("uses impersonation claims from the authenticated profile", async () => {
    mockAuthState = {
      ...mockAuthState,
      user: {
        profile: {
          hercules_impersonation_session_id: "session_1",
          hercules_actor_sub: "actor_1",
        },
      },
    };

    const { result } = renderHook(() => useHerculesImpersonation());

    expect(result.current).toMatchObject({
      isImpersonating: true,
      sessionId: "session_1",
      actorSub: "actor_1",
    });
    await waitFor(() => {
      expect(window.localStorage.getItem(storageKey)).toContain("session_1");
    });
  });

  it("ignores stale stored impersonation after normal login", async () => {
    rememberHerculesImpersonationSession(storageKey, "old_session");

    const { result } = renderHook(() => useHerculesImpersonation());

    expect(result.current).toMatchObject({
      isImpersonating: false,
      sessionId: null,
      actorSub: null,
    });
    await waitFor(() => {
      expect(window.localStorage.getItem(storageKey)).toBeNull();
    });
  });
});

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}
