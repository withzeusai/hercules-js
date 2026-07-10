// Transport layer, following posthog-js request.ts: fetch with keepalive for
// normal sends (so failures are observable and retryable), sendBeacon for
// unload-time sends (fire-and-forget, survives the page closing).

import { nav } from "./globals";

export type Transport = "fetch" | "sendBeacon";

export interface RequestResponse {
  /** HTTP status, or 0 when the request failed to complete */
  statusCode: number;
}

export interface RequestOptions {
  url: string;
  body: string;
  transport?: Transport | undefined;
  callback?: (response: RequestResponse) => void;
}

export function request(options: RequestOptions): void {
  const { url, body, callback } = options;

  if (options.transport === "sendBeacon" && nav?.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    try {
      // A true result only says the payload was queued, but that is the best
      // signal available during unload — report it as success. On false the
      // batch was NOT queued (beacon quota / payload size), and the caller
      // already dropped it from its buffer, so fall through to fetch with
      // keepalive rather than losing it. (Upstream posthog-js ignores the
      // return value; falling back is strictly better here.)
      if (nav.sendBeacon(url, blob)) {
        callback?.({ statusCode: 200 });
        return;
      }
    } catch {
      // fall through to fetch
    }
  }

  if (typeof fetch !== "function") {
    callback?.({ statusCode: 0 });
    return;
  }

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: body.length < 60_000, // keepalive bodies are capped at 64 KiB
  })
    .then((response) => callback?.({ statusCode: response.status }))
    .catch(() => callback?.({ statusCode: 0 }));
}
