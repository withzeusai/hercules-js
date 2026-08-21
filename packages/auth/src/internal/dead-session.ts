import type { UserManager } from "oidc-client-ts";

/**
 * Recovery for a refresh token the authorization server will never accept
 * again.
 *
 * When a `refresh_token` grant fails with `invalid_grant`, the stored token is
 * permanently dead -- the server has revoked, rotated past, or deleted it.
 * `oidc-client-ts` throws out of `_useRefreshToken` before reaching
 * `storeUser`, so the dead token stays in `localStorage`, and
 * `react-oidc-context`'s error reducer leaves `isAuthenticated` true. Every
 * later renew -- on reload, in a new tab, from the expiry timer, or from
 * Convex's `fetchAccessToken` -- replays the same dead token and fails
 * identically.
 *
 * That is why this failure is permanent rather than transient: in production
 * it turns a single bad renew into an unbounded stream of identical errors,
 * with users stuck until they manually clear site data. Discarding the dead
 * user makes the next interaction a normal interactive sign-in.
 */

/** OAuth 2.0 error code for a refresh token the server refuses outright. */
const INVALID_GRANT = "invalid_grant";

/**
 * Whether `error` is an `invalid_grant` response.
 *
 * `oidc-client-ts` surfaces the OAuth `error` field on `ErrorResponse`, but the
 * class is not always identity-comparable across bundled copies, so this reads
 * the field structurally rather than via `instanceof`.
 */
export function isInvalidGrantError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { error?: unknown }).error === INVALID_GRANT;
}

/**
 * Discard the stored user when `error` means the refresh token is dead.
 *
 * Returns whether the session was cleared. Never throws: this runs inside
 * failure handlers, where a secondary error would mask the original.
 */
export async function clearSessionIfInvalidGrant(
  userManager: Pick<UserManager, "removeUser">,
  error: unknown,
): Promise<boolean> {
  if (!isInvalidGrantError(error)) return false;

  try {
    await userManager.removeUser();
    return true;
  } catch {
    return false;
  }
}
