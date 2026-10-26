// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { ConvexReactClient } from "convex/react";
import { anyApi } from "convex/server";
import { ConvexProviderWithHerculesAuth } from "./ConvexProviderWithHercules.js";

// Real `convex/react` provider and client; only the Hercules session and the
// WebSocket are faked, so these tests see what actually reaches the wire.

let mockAuthState: Record<string, unknown> = {};
let mockIdTokenState: Record<string, unknown> = {};

vi.mock("../client/HerculesAuthProvider", () => ({
  useAuth: () => mockAuthState,
}));

vi.mock("../client/useIdToken", () => ({
  useIdToken: () => mockIdTokenState,
}));

const TOKEN = "header.payload.sig";

let sent: string[] = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  onopen?: (event: unknown) => void;

  constructor() {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 5);
  }

  send(data: string) {
    const message = JSON.parse(data) as { type: string; tokenType?: string };
    sent.push(
      message.type === "Authenticate" ? `Authenticate(${message.tokenType})` : message.type,
    );
  }

  close() {
    this.readyState = 3;
  }
}

function settle() {
  return act(() => new Promise((resolve) => setTimeout(resolve, 40)));
}

/** An `expectAuth` client with a query subscribed before React mounts, as SSR hydration does. */
function bootClient() {
  const client = new ConvexReactClient("https://example.convex.cloud", {
    expectAuth: true,
    webSocketConstructor: FakeWebSocket as never,
    unsavedChangesWarning: false,
    logger: false,
  });
  client.watchQuery(anyApi.people.list, {}).onUpdate(() => {});
  return client;
}

beforeEach(() => {
  sent = [];
});

describe("ConvexProviderWithHerculesAuth with a real expectAuth client", () => {
  it("runs a signed-out visitor's queries without a token", async () => {
    mockAuthState = { user: null, loading: false };
    mockIdTokenState = { idToken: undefined, loading: false, getIdToken: async () => undefined };
    const client = bootClient();
    await settle();
    expect(sent).toEqual([]);

    render(<ConvexProviderWithHerculesAuth client={client}>app</ConvexProviderWithHerculesAuth>);
    await settle();

    expect(sent).toContain("ModifyQuerySet");
    expect(sent).not.toContain("Authenticate(User)");
  });

  it("sends a seeded session's token before any query", async () => {
    mockAuthState = { user: { id: "user_1" }, loading: false };
    mockIdTokenState = { idToken: undefined, loading: true, getIdToken: async () => TOKEN };
    const client = bootClient();
    const view = render(
      <ConvexProviderWithHerculesAuth client={client}>app</ConvexProviderWithHerculesAuth>,
    );
    await settle();
    expect(sent).toEqual([]);

    mockIdTokenState = { idToken: TOKEN, loading: false, getIdToken: async () => TOKEN };
    view.rerender(
      <ConvexProviderWithHerculesAuth client={client}>app</ConvexProviderWithHerculesAuth>,
    );
    await settle();

    const authenticate = sent.indexOf("Authenticate(User)");
    expect(authenticate).toBeGreaterThanOrEqual(0);
    expect(authenticate).toBeLessThan(sent.indexOf("ModifyQuerySet"));
  });
});
