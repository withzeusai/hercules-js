/**
 * Reads a run's live events in the browser: `GET /v1/agents/runs/{id}/events`
 * as server-sent events, with the read-only run token. `fetch`, not
 * `EventSource`, because the token goes in the `Authorization` header.
 */
import {
  HERCULES_API_VERSION,
  isFinalEvent,
  readAgentEvent,
  type AgentEvent,
} from "./component/protocol";

export interface RunStreamOptions {
  /** The run's live URL, as `readThread` returns it in `activeRun.live`. */
  url: string;
  /** The run token that comes with it. */
  token: string;
  /** Start after this sequence number. 0, the default, replays the run from its start. */
  after?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Reconnection: the first wait and the longest, in milliseconds, and how many tries in a row. */
  retry?: { initialMs?: number; maxMs?: number; maxAttempts?: number };
}

/** The stream was refused: a bad or expired token, or a run that is gone. Retrying will not help. */
export class RunStreamError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.name = "RunStreamError";
    this.status = status;
    this.code = code;
  }
}

export interface ServerSentEvent {
  id: string | null;
  event: string | null;
  data: string;
}

/** Splits a server-sent event stream into its events. */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let event: string | null = null;
  let data: string[] = [];

  function* takeLines(final: boolean): Generator<ServerSentEvent> {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      // A lone "\r" at the end may be the first half of "\r\n".
      if (match === null || (!final && match[0] === "\r" && match.index === buffer.length - 1)) {
        return;
      }
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") {
        if (data.length > 0) yield { id, event, data: data.join("\n") };
        event = null;
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "id" && !value.includes("\0")) id = value;
      else if (field === "event") event = value;
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* takeLines(false);
    }
    buffer += decoder.decode();
    yield* takeLines(true);
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

async function problemCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "code" in body) {
      const code = (body as { code: unknown }).code;
      return typeof code === "string" ? code : null;
    }
  } catch {
    // Not a problem document.
  }
  return null;
}

/**
 * Follows a run's events live, reconnecting with `Last-Event-ID` until the
 * run's final event arrives or `signal` aborts. Each event comes once, in
 * order. Throws `RunStreamError` when Hercules refuses the stream, and after
 * `maxAttempts` failed connections in a row.
 */
export async function* followRun(options: RunStreamOptions): AsyncGenerator<AgentEvent> {
  const fetchFn = options.fetch ?? fetch;
  const initialMs = options.retry?.initialMs ?? 1000;
  const maxMs = options.retry?.maxMs ?? 30_000;
  const maxAttempts = options.retry?.maxAttempts ?? 10;
  let lastSeq = Math.max(0, options.after ?? 0);
  let failures = 0;

  while (!options.signal?.aborted) {
    let waitMs: number | null = null;
    try {
      const url = new URL(options.url);
      if (lastSeq > 0) url.searchParams.set("after", String(lastSeq));
      const response = await fetchFn(url, {
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "text/event-stream",
          "hercules-version": HERCULES_API_VERSION,
          ...(lastSeq > 0 && { "last-event-id": String(lastSeq) }),
        },
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      if (!response.ok || response.body === null) {
        if (!RETRYABLE_STATUSES.has(response.status)) {
          const code = await problemCode(response);
          throw new RunStreamError(
            `The run's live stream was refused (${response.status}${code === null ? "" : ` ${code}`})`,
            response.status,
            code,
          );
        }
        await response.body?.cancel().catch(() => undefined);
        const retryAfter = Number(response.headers.get("retry-after"));
        waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
        throw new Error(`The run's live stream answered ${response.status}`);
      }
      let received = false;
      for await (const message of parseEventStream(response.body)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          continue;
        }
        const event = readAgentEvent(parsed);
        if (event === null || event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        failures = 0;
        received = true;
        yield event;
        if (isFinalEvent(event)) return;
      }
      // The stream closed before the run's final event: pick up where it stopped.
      if (!received) throw new Error("The run's live stream closed with nothing new");
    } catch (error) {
      if (error instanceof RunStreamError) throw error;
      if (options.signal?.aborted) return;
      failures++;
      if (failures >= maxAttempts) {
        throw new RunStreamError(
          error instanceof Error ? error.message : "The run's live stream failed",
          null,
          null,
        );
      }
    }
    const backoff = Math.min(initialMs * 2 ** Math.max(0, failures - 1), maxMs);
    await sleep(waitMs ?? Math.floor(backoff / 2 + (Math.random() * backoff) / 2), options.signal);
  }
}
