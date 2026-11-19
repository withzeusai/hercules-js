/**
 * Reads a run's live events in the browser: `GET /v1/agents/runs/{id}/events`
 * as server-sent events, with the read-only run token. `fetch`, not
 * `EventSource`, because the token goes in the `Authorization` header.
 */
import {
  CLIENT_HEADER,
  CLIENT_ID,
  HERCULES_API_VERSION,
  isFinalEvent,
  readAgentEvent,
  readWireEvent,
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

/**
 * The run's live stream could not be read: Hercules refused it (a bad or
 * expired token, a run that is gone), or it kept failing, for example with
 * 429 `rate_limited` while more than ten streams of the run are open. It is
 * the live view that failed, not the run: the reply still reaches the app
 * through Convex.
 */
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

/**
 * The headers of a request for a run's live stream, resumed after `lastSeq`
 * when that is past 0. The page names this package and its version, as the
 * app's backend does on every request it makes. A browser sends a request
 * with these headers only when the route lists each of them among those a
 * page may send, and Hercules's events route lists them all.
 */
export function runStreamHeaders(token: string, lastSeq: number): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "text/event-stream",
    "hercules-version": HERCULES_API_VERSION,
    [CLIENT_HEADER]: CLIENT_ID,
    ...(lastSeq > 0 && { "last-event-id": String(lastSeq) }),
  };
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
/**
 * A stream that stayed open this long and then closed with nothing new is a
 * run that is quiet, not a connection that failed: Hercules closes a stream
 * after ten minutes, and a run can wait far longer than that.
 */
const QUIET_STREAM_MS = 60_000;

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
 *
 * A run's final event and a `message.completed` are passed on whatever their
 * sequence number: Hercules can number the ending of a run it had to end
 * itself at or below an event already streamed, and it must not be dropped.
 *
 * An event of a type this version does not know is not passed on. It keeps
 * its place: the stream is resumed after it. A run that is quiet for a long
 * time, waiting for a person say, is followed for as long as it takes, with
 * one connection per stream Hercules closes. An ending of a type this
 * version does not know ends the stream when Hercules marks it final, and
 * otherwise after `maxAttempts` connections that brought nothing new.
 */
export async function* followRun(options: RunStreamOptions): AsyncGenerator<AgentEvent> {
  const fetchFn = options.fetch ?? fetch;
  const initialMs = options.retry?.initialMs ?? 1000;
  const maxMs = options.retry?.maxMs ?? 30_000;
  const maxAttempts = options.retry?.maxAttempts ?? 10;
  let lastSeq = Math.max(0, options.after ?? 0);
  let failures = 0;
  /**
   * The `message.completed` events passed on, by sequence number. Hercules
   * sends a finished run's reply again to a reader at or past the run's end.
   */
  const repliesPassed = new Set<number>();
  /** The last answer that was not a stream, for the error if it never becomes one. */
  let lastRefusal: { status: number; code: string | null } | null = null;

  while (!options.signal?.aborted) {
    let waitMs: number | null = null;
    lastRefusal = null;
    try {
      const url = new URL(options.url);
      if (lastSeq > 0) url.searchParams.set("after", String(lastSeq));
      const response = await fetchFn(url, {
        headers: runStreamHeaders(options.token, lastSeq),
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      if (!response.ok || response.body === null) {
        // By its status, whatever its code: Hercules could not answer (these
        // and every 5xx), or the request is refused (any other 4xx).
        if (!RETRYABLE_STATUSES.has(response.status) && response.status < 500) {
          const code = await problemCode(response);
          throw new RunStreamError(
            `The run's live stream was refused (${response.status}${code === null ? "" : ` ${code}`})`,
            response.status,
            code,
          );
        }
        const retryAfter = Number(response.headers.get("retry-after"));
        waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
        lastRefusal = { status: response.status, code: await problemCode(response) };
        throw new Error(`The run's live stream answered ${response.status}`);
      }
      const openedAt = Date.now();
      let received = false;
      for await (const message of parseEventStream(response.body)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          continue;
        }
        const wire = readWireEvent(parsed);
        if (wire === null) continue;
        const event = readAgentEvent(parsed);
        if (event === null) {
          // A type this version does not know, or data it cannot read. Not
          // passed on, but it was sent: the stream is resumed after it.
          if (wire.seq > lastSeq) {
            lastSeq = wire.seq;
            failures = 0;
            received = true;
          }
          // An ending of a type added later, which Hercules marked: nothing follows it.
          if (wire.data.kind === "final") return;
          continue;
        }
        const final = isFinalEvent(event);
        if (event.seq <= lastSeq && !final) {
          // A repeat, unless it is a reply this reader has not passed on yet.
          if (event.type !== "message.completed" || repliesPassed.has(event.seq)) continue;
        }
        if (event.type === "message.completed") repliesPassed.add(event.seq);
        lastSeq = Math.max(lastSeq, event.seq);
        failures = 0;
        received = true;
        yield event;
        if (final) return;
      }
      // The stream closed before the run's final event: pick up where it
      // stopped. One that closed at once with nothing new counts as a failed
      // connection, so a run whose ending cannot be read here is not asked
      // for without end.
      if (!received && Date.now() - openedAt < QUIET_STREAM_MS) {
        throw new Error("The run's live stream closed with nothing new");
      }
    } catch (error) {
      if (error instanceof RunStreamError) throw error;
      if (options.signal?.aborted) return;
      failures++;
      if (failures >= maxAttempts) {
        throw new RunStreamError(
          error instanceof Error ? error.message : "The run's live stream failed",
          lastRefusal?.status ?? null,
          lastRefusal?.code ?? null,
        );
      }
    }
    const backoff = Math.min(initialMs * 2 ** Math.max(0, failures - 1), maxMs);
    await sleep(waitMs ?? Math.floor(backoff / 2 + (Math.random() * backoff) / 2), options.signal);
  }
}
