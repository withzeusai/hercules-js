/** The error fallback never has a provider-validated destination. */
export function signOutFallback(returnTo: string | undefined, origin: string): string {
  try {
    const url = new URL(returnTo ?? "/", `${origin}/`);
    if (url.origin === origin && (url.protocol === "https:" || url.protocol === "http:")) {
      return url.href;
    }
  } catch {
    // Invalid destinations fall back to the app home page.
  }
  return `${origin}/`;
}

const END_SESSION_TIMEOUT_MS = 5000;

/** Whether the app runs inside a frame. A cross-origin parent throws on access. */
export function isFramed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/**
 * Where to navigate to finish sign-out, given the URL the server returned.
 *
 * At the top level that is the URL itself. Inside a frame, such as the App
 * Builder preview, the provider's end-session page refuses to be framed and
 * the frame would end on a refused-to-connect error. There the end-session
 * request is sent in the background instead (the `id_token_hint` it carries
 * identifies the session to end, so no cookies are needed), and the frame
 * goes to its own post-logout destination. The server already cleared the
 * app session cookie on the response that produced `url`.
 */
export async function resolveSignOutNavigation(url: string, origin: string): Promise<string> {
  if (!isFramed()) return url;

  let target: URL;
  try {
    target = new URL(url, `${origin}/`);
  } catch {
    return url;
  }
  // Only the provider's end-session URL carries `post_logout_redirect_uri`; a
  // same-origin or sessionless destination is safe to navigate to directly.
  const postLogoutRedirectUri = target.searchParams.get("post_logout_redirect_uri");
  if (target.origin === origin || postLogoutRedirectUri === null) return url;

  await fetch(target.href, {
    mode: "no-cors",
    credentials: "omit",
    signal: AbortSignal.timeout(END_SESSION_TIMEOUT_MS),
  }).catch(() => undefined);
  return signOutFallback(postLogoutRedirectUri, origin);
}
