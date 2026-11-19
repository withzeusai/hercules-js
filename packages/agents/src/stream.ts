/**
 * Reads a run's live events in the browser: `GET /v1/agents/runs/{id}/events`
 * as server-sent events, with the read-only run token. `fetch`, not
 * `EventSource`, because the token goes in the `Authorization` header.
 */
import type { AgentEvent } from "./api";
import {
  CLIENT_HEADER,
  CLIENT_ID,
  HERCULES_API_VERSION,
  isFinalEvent,
  readWireEvent,
  type WireEvent,
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
 * An event as `followRun` hands it on: what Hercules sent, field for field,
 * under the API's names. Nothing is renamed, dropped or rewritten, at any
 * depth, so a field, a part type, a kind or a status the API adds later
 * reaches the app as it was sent. Three things are made sure of, since the
 * type promises them: the envelope's own fields are there (`id`,
 * `thread_id` and `created_at` read as Hercules sends them, or as `readWireEvent`
 * fills them in), `data` is an object, and `final` is a boolean. An event
 * from before Hercules sent `final` is final exactly when its type is one of
 * the four endings.
 */
function apiEvent(raw: Record<string, unknown>, wire: WireEvent, final: boolean): AgentEvent {
  const data: unknown = raw["data"];
  return {
    ...raw,
    id: typeof raw["id"] === "string" ? raw["id"] : `${wire.runId}:${wire.seq}`,
    seq: wire.seq,
    run_id: wire.runId,
    thread_id: wire.threadId,
    type: wire.type,
    created_at: wire.createdAt,
    final,
    data: typeof data === "object" && data !== null && !Array.isArray(data) ? data : {},
  } as unknown as AgentEvent;
}

/**
 * Follows a run's events live, reconnecting with `Last-Event-ID` until the
 * run's final event arrives or `signal` aborts. Each event comes once, in
 * order, as Hercules sent it: the API's own JSON, under the API's names.
 * Throws `RunStreamError` when Hercules refuses the stream, and after
 * `maxAttempts` failed connections in a row.
 *
 * The generator returns after the run's final event, the one whose `final`
 * is true, which it yields like any other. So an ending of a type this
 * version does not know is yielded too, and ends the loop.
 *
 * A run's final event and a `message.completed` are passed on whatever their
 * sequence number: Hercules can number the ending of a run it had to end
 * itself at or below an event already streamed, and it must not be dropped.
 *
 * An event of a type this version does not know is passed on as it came:
 * `String(event.type)` is its name. A run that is quiet for a long time,
 * waiting for a person say, is followed for as long as it takes, with one
 * connection per stream Hercules closes. A stream that closes at once with
 * nothing new is such a run too, not a failure: it is connected to again,
 * less and less often, and only a connection that fails counts toward
 * `maxAttempts`.
 */
export async function* followRun(options: RunStreamOptions): AsyncGenerator<AgentEvent> {
  const fetchFn = options.fetch ?? fetch;
  const initialMs = options.retry?.initialMs ?? 1000;
  const maxMs = options.retry?.maxMs ?? 30_000;
  const maxAttempts = options.retry?.maxAttempts ?? 10;
  let lastSeq = Math.max(0, options.after ?? 0);
  let failures = 0;
  /** Streams in a row that closed cleanly, at once, with nothing new. They only space the next ones out. */
  let quietCloses = 0;
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
        // Without a run, a sequence number and a type it cannot be placed.
        const wire = readWireEvent(parsed);
        if (wire === null) continue;
        const raw = parsed as Record<string, unknown>;
        // One of the four endings, or any type Hercules marks as the run's ending.
        const final = isFinalEvent({ type: wire.type, final: raw["final"] });
        if (wire.seq <= lastSeq && !final) {
          // A repeat, unless it is a reply this reader has not passed on yet.
          if (wire.type !== "message.completed" || repliesPassed.has(wire.seq)) continue;
        }
        if (wire.type === "message.completed") repliesPassed.add(wire.seq);
        lastSeq = Math.max(lastSeq, wire.seq);
        failures = 0;
        received = true;
        yield apiEvent(raw, wire, final);
        if (final) return;
      }
      // The stream closed before the run's final event: pick up where it
      // stopped. Hercules sends a finished run's ending to any reader,
      // whatever its cursor, so a stream that closes with nothing new is a
      // run that is not over: one that waits, in a status Hercules may add
      // later and close the stream for at once. That is not a failed
      // connection, and never ends the following. It is come back to less
      // and less often, up to the longest wait.
      quietCloses = !received && Date.now() - openedAt < QUIET_STREAM_MS ? quietCloses + 1 : 0;
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
    const backoff = Math.min(initialMs * 2 ** Math.max(0, failures + quietCloses - 1), maxMs);
    await sleep(waitMs ?? Math.floor(backoff / 2 + (Math.random() * backoff) / 2), options.signal);
  }
}
