import { createServerFn } from "@tanstack/react-start";
import type { ClientUserInfo, NoUserInfo } from "../types";

// These server functions back the client hooks. Their handlers dynamically
// import the server-only implementation (`./action-bodies`, which pulls in
// `openid-client`) so that nothing server-only is statically reachable from the
// client bundle — the createServerFn boundary replaces each handler with an RPC
// stub on the client.

/** Sanitized auth state (no access token). Seeds/refreshes the provider. */
export const getAuthAction = createServerFn({ method: "GET" }).handler(
  async (): Promise<ClientUserInfo | NoUserInfo> => {
    const { getAuthBody } = await import("./action-bodies");
    return getAuthBody();
  },
);

/** Whether a valid session exists. Used to detect session expiration. */
export const checkSessionAction = createServerFn({ method: "GET" }).handler(async (): Promise<boolean> => {
  const { checkSessionBody } = await import("./action-bodies");
  return checkSessionBody();
});

/** The current access token for the session, if authenticated. */
export const getAccessTokenAction = createServerFn({ method: "GET" }).handler(
  async (): Promise<string | undefined> => {
    const { getAccessTokenBody } = await import("./action-bodies");
    return getAccessTokenBody();
  },
);

/** Refresh the session and return the new access token. */
export const refreshAccessTokenAction = createServerFn({ method: "POST" }).handler(
  async (): Promise<string | undefined> => {
    const { refreshAccessTokenBody } = await import("./action-bodies");
    return refreshAccessTokenBody();
  },
);

/** Refresh the session and return sanitized auth state (no access token). */
export const refreshAuthAction = createServerFn({ method: "POST" }).handler(
  async (): Promise<ClientUserInfo | NoUserInfo> => {
    const { refreshAuthBody } = await import("./action-bodies");
    return refreshAuthBody();
  },
);

/** Clear the session and return where to navigate to complete sign-out. */
export const getSignOutUrl = createServerFn({ method: "POST" })
  .validator((options?: { returnTo?: string }) => options)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const { getSignOutUrlBody } = await import("./action-bodies");
    return getSignOutUrlBody(data?.returnTo);
  });
