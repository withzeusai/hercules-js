import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyAuthError,
  getOrCreateAuthAttemptId,
  reportAuthDiagnostic,
  startAuthAttempt,
  __resetDiagnosticsState,
  type AuthDiagnosticEvent,
} from "./diagnostics.js";

function setLocation(url: string) {
  const u = new URL(url);
  Object.defineProperty(window, "location", {
    value: {
      origin: u.origin,
      pathname: u.pathname,
      search: u.search,
      href: u.href,
    },
    configurable: true,
    writable: true,
  });
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    value: online,
    configurable: true,
  });
}

beforeEach(() => {
  __resetDiagnosticsState();
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
  setLocation("https://app.example.com/auth/callback");
  setOnline(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyAuthError", () => {
  it("classifies fetch network errors as failed_fetch", () => {
    const err = new TypeError("Failed to fetch");
    expect(classifyAuthError(err, "signin-redirect-failed")).toBe(
      "failed_fetch",
    );
  });

  it("classifies firefox-style network errors as failed_fetch", () => {
    const err = new Error("NetworkError when attempting to fetch resource");
    (err as { name: string }).name = "NetworkError";
    expect(classifyAuthError(err, "signin-redirect-failed")).toBe(
      "failed_fetch",
    );
  });

  it("classifies state-mismatch errors as missing_oidc_state", () => {
    const err = new Error("No matching state found in storage");
    expect(classifyAuthError(err, "oidc-error")).toBe("missing_oidc_state");
  });

  it("classifies issuer mismatch errors", () => {
    const err = new Error("Invalid issuer in token response");
    expect(classifyAuthError(err, "oidc-error")).toBe("issuer_mismatch");
  });

  it("classifies callback-timeout phase regardless of error", () => {
    expect(classifyAuthError(undefined, "callback-timeout")).toBe(
      "callback_timeout",
    );
  });

  it("classifies backend-sync-failed phase regardless of error", () => {
    expect(classifyAuthError(new Error("anything"), "backend-sync-failed")).toBe(
      "backend_sync_failed",
    );
  });

  it("classifies callback-not-authenticated as missing_oidc_state", () => {
    expect(
      classifyAuthError(
        new Error("callback completed but not authenticated"),
        "callback-not-authenticated",
      ),
    ).toBe("missing_oidc_state");
  });

  it("classifies generic oidc-error as oidc_provider_error", () => {
    expect(classifyAuthError(new Error("invalid_grant"), "oidc-error")).toBe(
      "oidc_provider_error",
    );
  });

  it("falls back to unknown for unrecognized errors", () => {
    expect(
      classifyAuthError(new Error("something weird"), "signin-redirect-failed"),
    ).toBe("unknown");
  });
});

describe("attempt id", () => {
  it("returns the same attempt id within a session", () => {
    const a = getOrCreateAuthAttemptId();
    const b = getOrCreateAuthAttemptId();
    expect(a).toBe(b);
  });

  it("persists the attempt id to sessionStorage", () => {
    const id = getOrCreateAuthAttemptId();
    expect(sessionStorage.getItem("_hrc_auth_attempt")).toBe(id);
  });

  it("startAuthAttempt rotates the attempt id", () => {
    const first = getOrCreateAuthAttemptId();
    const second = startAuthAttempt();
    expect(second).not.toBe(first);
  });

  it("falls back to in-memory id when sessionStorage throws", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });

    const id = getOrCreateAuthAttemptId();
    expect(id).toBeTruthy();

    // second call should return same in-memory id
    expect(getOrCreateAuthAttemptId()).toBe(id);

    setItem.mockRestore();
    getItem.mockRestore();
  });
});

describe("reportAuthDiagnostic", () => {
  let beaconCalls: { url: string; body: string }[];
  let originalSendBeacon: typeof navigator.sendBeacon | undefined;

  beforeEach(() => {
    beaconCalls = [];
    originalSendBeacon = navigator.sendBeacon;
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: vi.fn((url: string, body: BodyInit) => {
        if (body instanceof Blob) {
          return body.text().then(
            (text) => {
              beaconCalls.push({ url, body: text });
              return true;
            },
            () => true,
          ) as unknown as boolean;
        }
        beaconCalls.push({ url, body: String(body) });
        return true;
      }),
    });
  });

  afterEach(() => {
    if (originalSendBeacon) {
      Object.defineProperty(navigator, "sendBeacon", {
        configurable: true,
        writable: true,
        value: originalSendBeacon,
      });
    }
  });

  it("respects enabled: false (no observer, no send)", () => {
    const onDiagnostic = vi.fn();
    reportAuthDiagnostic(
      { enabled: false, onDiagnostic },
      { phase: "signin-redirect-failed", error: new Error("boom") },
    );
    expect(onDiagnostic).not.toHaveBeenCalled();
    expect(beaconCalls).toHaveLength(0);
  });

  it("respects reportToHercules: false but still fires observer", () => {
    const onDiagnostic = vi.fn();
    reportAuthDiagnostic(
      { reportToHercules: false, onDiagnostic },
      { phase: "signin-redirect-failed", error: new Error("boom") },
    );
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(beaconCalls).toHaveLength(0);
  });

  it("posts to the configured endpoint when enabled", async () => {
    reportAuthDiagnostic(
      { endpoint: "/_hercules/report" },
      {
        phase: "signin-redirect-failed",
        error: new TypeError("Failed to fetch"),
        authority: "https://issuer.example.com",
        clientId: "client_abc",
        redirectUri: "https://app.example.com/auth/callback",
      },
    );

    // sendBeacon mock resolves async because Blob.text() is async
    await new Promise((r) => setTimeout(r, 0));
    expect(beaconCalls).toHaveLength(1);
    expect(beaconCalls[0]!.url).toBe("/_hercules/report");
    const body = JSON.parse(beaconCalls[0]!.body) as AuthDiagnosticEvent;
    expect(body.phase).toBe("signin-redirect-failed");
    expect(body.errorClass).toBe("failed_fetch");
    expect(body.authorityHost).toBe("issuer.example.com");
    expect(body.clientId).toBe("client_abc");
    expect(body.redirectUriOrigin).toBe("https://app.example.com");
    expect(body.redirectUriPath).toBe("/auth/callback");
    expect(body.origin).toBe("https://app.example.com");
    expect(body.online).toBe(true);
    expect(body.storageAvailable).toBe(true);
    expect(body.authAttemptId).toBeTruthy();
  });

  it("dedupes repeated failures with the same normalized key within the window", async () => {
    const onDiagnostic = vi.fn();
    const send = (label: string) =>
      reportAuthDiagnostic(
        { onDiagnostic },
        {
          phase: "signin-redirect-failed",
          error: new TypeError(`Failed to fetch ${label}`),
          authority: "https://issuer.example.com",
        },
      );

    send("a");
    send("b");
    send("c");

    expect(onDiagnostic).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedupe events whose normalized key differs", () => {
    const onDiagnostic = vi.fn();
    reportAuthDiagnostic(
      { onDiagnostic },
      {
        phase: "signin-redirect-failed",
        error: new TypeError("Failed to fetch"),
        authority: "https://a.example.com",
      },
    );
    reportAuthDiagnostic(
      { onDiagnostic },
      {
        phase: "signin-redirect-failed",
        error: new TypeError("Failed to fetch"),
        authority: "https://b.example.com",
      },
    );
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
  });

  it("never sends sensitive fields like code, state, full URL, or tokens", async () => {
    setLocation(
      "https://app.example.com/auth/callback?code=SECRET_CODE&state=SECRET_STATE&error=interaction_required",
    );
    reportAuthDiagnostic(
      {},
      {
        phase: "callback-not-authenticated",
        error: new Error("oidc callback completed but not authenticated"),
        authority: "https://issuer.example.com",
      },
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(beaconCalls).toHaveLength(1);
    const raw = beaconCalls[0]!.body;
    expect(raw).not.toContain("SECRET_CODE");
    expect(raw).not.toContain("SECRET_STATE");
    const event = JSON.parse(raw) as AuthDiagnosticEvent;
    expect(event.hasCode).toBe(true);
    expect(event.hasState).toBe(true);
    expect(event.hasErrorParam).toBe(true);
  });

  it("reports storageAvailable: false when sessionStorage is broken", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    reportAuthDiagnostic(
      {},
      { phase: "signin-redirect-failed", error: new Error("boom") },
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(beaconCalls).toHaveLength(1);
    const event = JSON.parse(beaconCalls[0]!.body) as AuthDiagnosticEvent;
    expect(event.storageAvailable).toBe(false);
    expect(event.authAttemptId).toBeTruthy();
  });

  it("truncates oversized error messages", async () => {
    const longMsg = "x".repeat(2000);
    reportAuthDiagnostic(
      {},
      {
        phase: "backend-sync-failed",
        error: new Error(longMsg),
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    const event = JSON.parse(beaconCalls[0]!.body) as AuthDiagnosticEvent;
    expect(event.errorMessage?.length).toBeLessThanOrEqual(501);
  });

  it("falls back to fetch when sendBeacon is unavailable", async () => {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    reportAuthDiagnostic(
      { endpoint: "/_hercules/report" },
      { phase: "signin-redirect-failed", error: new Error("boom") },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe(
      "text/plain;charset=UTF-8",
    );
    expect(init?.credentials).toBe("omit");
    expect(init?.keepalive).toBe(true);
  });

  it("never throws even when the transport throws synchronously", () => {
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error("beacon broken");
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch broken");
    });

    expect(() =>
      reportAuthDiagnostic(
        {},
        { phase: "signin-redirect-failed", error: new Error("boom") },
      ),
    ).not.toThrow();
    fetchSpy.mockRestore();
  });
});
