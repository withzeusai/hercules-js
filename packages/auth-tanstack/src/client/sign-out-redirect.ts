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
