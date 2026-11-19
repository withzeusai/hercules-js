/**
 * The package's defaults and limits, held to their values.
 *
 * - The documented ones: what the README states under "Defaults and limits"
 *   (what an option is when left out, and the limits an app is designed
 *   around). An app that was built against one keeps running against it, so
 *   a change to any of them is a breaking change, and the README and the
 *   changelog have to say so.
 * - The package's own timing: how soon it asks again, how long it keeps a
 *   key. The README does not state these and they may be tuned. They are
 *   held here so that a change to one is made on purpose.
 *
 * The ones that need the component are held where its harness is, under
 * "the documented defaults" in `agents.test.ts`; `settleTimeoutMs` in
 * `tanstack.test.ts`; `principals` and `agentOrigins` in `server.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_API_URL,
  EVENTS_PATH,
  MAX_INPUT_CHARS,
  PAGE_ACTION_LISTED_MS,
  PAGE_ACTION_TTL_MS,
  isPageActionFresh,
} from "../component/protocol";
import {
  DEFAULT_MESSAGE_LIMIT,
  MAX_MESSAGE_LIMIT,
  READ_BUDGET_BYTES,
  STUCK_AFTER_MS,
} from "../component/store";
import { createTokenVerifier } from "../jwt";
import { followRun, RunStreamError } from "../stream";
import { AUDIENCE, createTestIssuer, ISSUER, NOW_MS, NOW_SECONDS, userClaims } from "./helpers";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the documented defaults", () => {
  it("names the Hercules API and the events route", () => {
    expect(DEFAULT_API_URL).toBe("https://api.hercules.app");
    expect(EVENTS_PATH).toBe("/hercules/agents/events");
  });

  it("limits a message to 262,144 characters", () => {
    expect(MAX_INPUT_CHARS).toBe(262_144);
  });

  it("reads 100 messages of a thread, 200 at most, and about 4 MiB", () => {
    expect(DEFAULT_MESSAGE_LIMIT).toBe(100);
    expect(MAX_MESSAGE_LIMIT).toBe(200);
    expect(READ_BUDGET_BYTES).toBe(4 * 1024 * 1024);
  });

  it("lets a page action be claimed for 120 seconds", () => {
    expect(PAGE_ACTION_TTL_MS).toBe(120 * SECOND);
    const calledAt = "2026-11-15T12:00:00.000Z";
    const at = Date.parse(calledAt);
    expect(isPageActionFresh(calledAt, at + 120 * SECOND - 1)).toBe(true);
    expect(isPageActionFresh(calledAt, at + 120 * SECOND)).toBe(false);
  });
});

describe("the package's own timing, which the README does not state", () => {
  it("asks Hercules about a run with nothing delivered after three minutes", () => {
    expect(STUCK_AFTER_MS).toBe(3 * MINUTE);
  });

  it("lists a page action no tab ran for ten minutes", () => {
    expect(PAGE_ACTION_LISTED_MS).toBe(10 * MINUTE);
  });
});

describe("followRun's retry, left out", () => {
  it("waits from one second up to thirty, and gives up after ten tries in a row", async () => {
    vi.useFakeTimers();
    // No jitter: each wait is then half its backoff, to the millisecond.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout);
    let requests = 0;
    const fetchFn = (async () => {
      requests++;
      return new Response("down", { status: 500 });
    }) as typeof fetch;

    const failure = (async () => {
      for await (const event of followRun({
        url: "https://api.hercules.test/v1/agents/runs/run_1/events",
        token: "t",
        fetch: fetchFn,
      })) {
        void event;
      }
    })().catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await failure).toBeInstanceOf(RunStreamError);
    expect(requests).toBe(10);
    // The backoff doubles from 1,000 ms and stops at 30,000 ms.
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000]);
  });
});

describe("the issuer's keys, whose timing the README does not state", () => {
  async function setup() {
    let nowMs = NOW_MS;
    const issuer = await createTestIssuer();
    const verifier = createTokenVerifier({
      issuer: ISSUER,
      audiences: [AUDIENCE],
      fetch: issuer.fetch,
      now: () => nowMs,
    });
    return {
      issuer,
      verifier,
      advance(ms: number) {
        nowMs += ms;
      },
    };
  }

  it("are kept for five minutes", async () => {
    const { issuer, verifier, advance } = await setup();
    const token = await issuer.sign(userClaims({ exp: NOW_SECONDS + 3600 }));
    expect((await verifier.verify(token)).ok).toBe(true);
    advance(5 * MINUTE - 1);
    expect((await verifier.verify(token)).ok).toBe(true);
    expect(issuer.jwksFetches()).toBe(1);
    advance(2);
    expect((await verifier.verify(token)).ok).toBe(true);
    expect(issuer.jwksFetches()).toBe(2);
  });

  it("are fetched again for a key they lack thirty seconds after the last fetch, not sooner", async () => {
    const { issuer, verifier, advance } = await setup();
    expect((await verifier.verify(await issuer.sign(userClaims()))).ok).toBe(true);
    const unknown = await issuer.sign(userClaims(), { kid: "key-9" });
    advance(30 * SECOND - 1);
    expect(await verifier.verify(unknown)).toEqual({ ok: false, reason: "keys_unavailable" });
    expect(issuer.jwksFetches()).toBe(1);
    advance(1);
    expect(await verifier.verify(unknown)).toEqual({ ok: false, reason: "unknown_key" });
    expect(issuer.jwksFetches()).toBe(2);
  });
});
