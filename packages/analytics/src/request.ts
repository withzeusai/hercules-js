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
      // sendBeacon result only says the payload was queued; report it as
      // success either way — there is nobody left to retry during unload.
      nav.sendBeacon(url, blob);
      callback?.({ statusCode: 200 });
      return;
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
