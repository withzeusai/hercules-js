/**
 * Cloudflare Turnstile for embedded sign-in.
 *
 * Email, password, username, and phone sign-in require a Turnstile token. The
 * Hercules site key only renders on Hercules auth hostnames, so an app renders
 * the widget through a small bridge page on its tenant's auth host (the OIDC
 * issuer). The bridge posts each token to the app's origin only when that
 * origin belongs to the tenant. Social sign-in and email-code entry need no
 * token.
 */

export interface TurnstileBridgeOptions {
  /** The tenant's OIDC issuer, e.g. `https://<slug>.hercules-auth.com`. */
  issuer: string;
  /** Element the bridge iframe is appended to. It renders about 65px tall. */
  container: HTMLElement;
  /** Widget language (`en`, `es`, ...). Defaults to the bridge's default. */
  language?: string;
  /** Accessible title for the iframe. */
  title?: string;
}

export interface TurnstileBridge {
  /**
   * The current token, waiting for the widget to issue one. Tokens are single
   * use: call {@link reset} after each request that consumed one.
   */
  getToken(timeoutMs?: number): Promise<string>;
  /** Drop the current token and ask the widget for a new one. */
  reset(): void;
  /** Remove the iframe and its listener. */
  destroy(): void;
  readonly iframe: HTMLIFrameElement;
}

const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

export function mountTurnstileBridge(options: TurnstileBridgeOptions): TurnstileBridge {
  const issuerOrigin = new URL(options.issuer).origin;
  const src = new URL("/turnstile-bridge", issuerOrigin);
  src.searchParams.set("origin", window.location.origin);
  if (options.language) src.searchParams.set("lang", options.language);

  const iframe = document.createElement("iframe");
  iframe.src = src.toString();
  iframe.title = options.title ?? "Security verification";
  iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
  iframe.style.border = "none";
  iframe.style.width = "100%";
  iframe.style.height = "65px";
  iframe.style.overflow = "hidden";
  iframe.style.colorScheme = "normal";
  options.container.appendChild(iframe);

  let token: string | undefined;
  let waiters: { resolve: (token: string) => void; reject: (error: Error) => void }[] = [];

  function settle(error?: Error) {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      if (error) waiter.reject(error);
      else if (token) waiter.resolve(token);
    }
  }

  function onMessage(event: MessageEvent) {
    if (event.origin !== issuerOrigin || event.source !== iframe.contentWindow) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null || !("type" in data)) return;
    if (data.type === "turnstile-token" && "token" in data && typeof data.token === "string") {
      token = data.token;
      settle();
    } else if (data.type === "turnstile-expired") {
      token = undefined;
    } else if (data.type === "turnstile-error") {
      token = undefined;
      settle(new Error("Security verification failed. Please try again."));
    }
  }
  window.addEventListener("message", onMessage);

  return {
    iframe,
    getToken(timeoutMs = DEFAULT_TOKEN_TIMEOUT_MS) {
      if (token) return Promise.resolve(token);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter.resolve !== done);
          reject(new Error("Security verification timed out. Please try again."));
        }, timeoutMs);
        function done(value: string) {
          clearTimeout(timer);
          resolve(value);
        }
        waiters.push({
          resolve: done,
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    reset() {
      token = undefined;
      iframe.contentWindow?.postMessage({ type: "turnstile-reset" }, issuerOrigin);
    },
    destroy() {
      window.removeEventListener("message", onMessage);
      settle(new Error("Security verification was removed."));
      iframe.remove();
    },
  };
}
