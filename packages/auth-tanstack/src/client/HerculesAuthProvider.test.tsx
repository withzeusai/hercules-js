// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientUserInfo } from "../types";

const actions = vi.hoisted(() => ({
  checkSessionAction: vi.fn(),
  getAuthAction: vi.fn(),
  getSignOutUrl: vi.fn(),
  refreshAuthAction: vi.fn(),
  getSessionTokensAction: vi.fn(),
  refreshSessionTokensAction: vi.fn(),
}));

vi.mock("../server/actions", () => actions);

import { HerculesAuthProvider, useAuth } from "./HerculesAuthProvider";
import { tokenSource } from "./tokenStore";

const SIGNED_IN: ClientUserInfo = {
  user: {
    id: "user_1",
    email: "ada@example.com",
    emailVerified: true,
    firstName: null,
    lastName: null,
    profilePictureUrl: null,
  },
  sessionId: "session_1",
  roles: [],
  permissions: [],
  entitlements: [],
  featureFlags: [],
};

function UserEmail() {
  const { user } = useAuth();
  return <span>{user ? user.email : "signed out"}</span>;
}

function renderProvider(initialAuth: ClientUserInfo | { user: null } = SIGNED_IN) {
  const onSessionExpired = vi.fn();
  const view = render(
    <HerculesAuthProvider initialAuth={initialAuth} onSessionExpired={onSessionExpired}>
      <UserEmail />
    </HerculesAuthProvider>,
  );
  return { ...view, onSessionExpired };
}

beforeEach(() => {
  vi.clearAllMocks();
  tokenSource.reset();
  // What the server returns once the session cookie no longer unseals.
  actions.getSessionTokensAction.mockResolvedValue({ serverTime: Date.now() });
});

afterEach(cleanup);

describe("HerculesAuthProvider when a token read comes back empty", () => {
  it("moves to signed out once the server confirms the session is gone", async () => {
    actions.checkSessionAction.mockResolvedValue(false);
    const { getByText, onSessionExpired } = renderProvider();

    await tokenSource.fetch();

    await waitFor(() => expect(getByText("signed out")).toBeTruthy());
    expect(actions.checkSessionAction).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("keeps the user when the server still has a session", async () => {
    actions.checkSessionAction.mockResolvedValue(true);
    const { getByText, onSessionExpired } = renderProvider();

    await tokenSource.fetch();

    await waitFor(() => expect(actions.checkSessionAction).toHaveBeenCalledTimes(1));
    expect(getByText("ada@example.com")).toBeTruthy();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("leaves a signed-out page alone", async () => {
    renderProvider({ user: null });

    await tokenSource.fetch();

    expect(actions.checkSessionAction).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", async () => {
    const { unmount } = renderProvider();
    unmount();

    await tokenSource.fetch();

    expect(actions.checkSessionAction).not.toHaveBeenCalled();
  });
});
