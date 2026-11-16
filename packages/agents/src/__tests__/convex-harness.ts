/**
 * A small in-memory Convex for the component's tests: tables with the
 * schema's indexes, mutations that roll back when they throw, a scheduler on
 * a fake clock, and calls between the app and the component resolved by
 * reference. Arguments, return values and documents are checked against
 * their validators, as Convex does.
 */
import {
  componentsGeneric,
  getFunctionAddress,
  type FunctionReference,
  type UserIdentity,
} from "convex/server";
import { vi } from "vitest";
import type { ComponentApi } from "../component/_generated/component";
import * as events from "../component/events";
import * as hercules from "../component/hercules";
import schema from "../component/schema";
import * as threads from "../component/threads";

type Json = Record<string, any>;
type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

interface Registered {
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
  exportArgs(): string;
  exportReturns(): string | null;
  _handler(ctx: unknown, args: unknown): unknown;
}

const MODULES: Record<string, Record<string, unknown>> = { events, hercules, threads };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a value against a validator in Convex's exported JSON form. */
export function checkValue(json: Json, value: unknown, path: string): void {
  const fail = (expected: string) => {
    throw new Error(`${path}: expected ${expected}, got ${JSON.stringify(value)?.slice(0, 200)}`);
  };
  switch (json["type"]) {
    case "any":
      return;
    case "null":
      if (value !== null) fail("null");
      return;
    case "number":
      if (typeof value !== "number") fail("a number");
      return;
    case "boolean":
      if (typeof value !== "boolean") fail("a boolean");
      return;
    case "string":
    case "id":
      if (typeof value !== "string") fail("a string");
      return;
    case "literal":
      if (value !== json["value"]) fail(JSON.stringify(json["value"]));
      return;
    case "array":
      if (!Array.isArray(value)) fail("an array");
      (value as unknown[]).forEach((entry, i) => checkValue(json["value"], entry, `${path}[${i}]`));
      return;
    case "record":
      if (!isPlainObject(value)) fail("an object");
      for (const [key, entry] of Object.entries(value as object)) {
        if (key.startsWith("$")) fail("no $ keys");
        checkValue(json["values"]["fieldType"], entry, `${path}.${key}`);
      }
      return;
    case "object": {
      if (!isPlainObject(value)) fail("an object");
      const fields = json["value"] as Record<string, { fieldType: Json; optional: boolean }>;
      for (const key of Object.keys(value as object)) {
        if ((value as Json)[key] !== undefined && !(key in fields)) fail(`no field ${key}`);
      }
      for (const [key, field] of Object.entries(fields)) {
        const entry = (value as Json)[key];
        if (entry === undefined) {
          if (!field.optional) fail(`a value for ${key}`);
          continue;
        }
        checkValue(field.fieldType, entry, `${path}.${key}`);
      }
      return;
    }
    case "union": {
      for (const member of json["value"] as Json[]) {
        try {
          checkValue(member, value, path);
          return;
        } catch {
          // Try the next member.
        }
      }
      fail("one of the union's members");
      return;
    }
    default:
      throw new Error(`${path}: unsupported validator ${String(json["type"])}`);
  }
}

function compare(a: unknown, b: unknown): number {
  const rank = (value: unknown) =>
    value === undefined ? 0 : value === null ? 1 : typeof value === "number" ? 2 : 3;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

type Condition = { field: string; op: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown };

class FakeDb {
  tables = new Map<string, Map<string, Doc>>();
  private counter = 0;

  constructor(private readonly now: () => number) {}

  private table(name: string): Map<string, Doc> {
    let table = this.tables.get(name);
    if (table === undefined) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  private check(name: string, doc: Record<string, unknown>) {
    const definition = (schema.tables as unknown as Record<string, { validator: { json: Json } }>)[
      name
    ];
    if (definition === undefined) throw new Error(`No table ${name}`);
    const { _id, _creationTime, ...fields } = doc;
    checkValue(definition.validator.json, fields, name);
  }

  all(name: string): Doc[] {
    return [...this.table(name).values()];
  }

  async get(id: string): Promise<Doc | null> {
    const [name] = id.split(":");
    return structuredClone(this.table(name as string).get(id) ?? null);
  }

  async insert(name: string, value: Record<string, unknown>): Promise<string> {
    const id = `${name}:${++this.counter}`;
    const doc = {
      ...withoutUndefined(value),
      _id: id,
      _creationTime: this.now() + this.counter / 1000,
    };
    this.check(name, doc);
    this.table(name).set(id, structuredClone(doc));
    return id;
  }

  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const [name] = id.split(":") as [string];
    const doc = this.table(name).get(id);
    if (doc === undefined) throw new Error(`patch: no document ${id}`);
    const next = withoutUndefined({ ...doc, ...fields }) as Doc;
    this.check(name, next);
    this.table(name).set(id, structuredClone(next));
  }

  async delete(id: string): Promise<void> {
    const [name] = id.split(":") as [string];
    if (!this.table(name).delete(id)) throw new Error(`delete: no document ${id}`);
  }

  query(name: string) {
    const db = this;
    let indexFields: string[] = [];
    const conditions: Condition[] = [];
    let descending = false;

    function results(): Doc[] {
      const docs = db.all(name).filter((doc) =>
        conditions.every((condition) => {
          const order = compare(doc[condition.field], condition.value);
          switch (condition.op) {
            case "eq":
              return order === 0;
            case "gt":
              return order > 0;
            case "gte":
              return order >= 0;
            case "lt":
              return order < 0;
            case "lte":
              return order <= 0;
          }
        }),
      );
      const keys = [...indexFields, "_creationTime", "_id"];
      docs.sort((a, b) => {
        for (const key of keys) {
          const order = compare(a[key], b[key]);
          if (order !== 0) return order;
        }
        return 0;
      });
      if (descending) docs.reverse();
      return docs.map((doc) => structuredClone(doc));
    }

    const builder = {
      withIndex(indexName: string, range?: (q: any) => unknown) {
        const definition = (
          schema.tables as unknown as Record<
            string,
            { [" indexes"](): { indexDescriptor: string; fields: string[] }[] }
          >
        )[name];
        const index = definition?.[" indexes"]().find(
          (entry) => entry.indexDescriptor === indexName,
        );
        if (index === undefined) throw new Error(`No index ${name}.${indexName}`);
        indexFields = index.fields;
        const allowed = [...index.fields, "_creationTime"];
        const q: Record<string, unknown> = {};
        for (const op of ["eq", "gt", "gte", "lt", "lte"] as const) {
          q[op] = (field: string, value: unknown) => {
            if (!allowed.includes(field)) throw new Error(`${field} is not in ${indexName}`);
            conditions.push({ field, op, value });
            return q;
          };
        }
        range?.(q);
        return builder;
      },
      order(direction: "asc" | "desc") {
        descending = direction === "desc";
        return builder;
      },
      async collect() {
        return results();
      },
      async take(n: number) {
        return results().slice(0, n);
      },
      async first() {
        return results()[0] ?? null;
      },
      async unique() {
        const found = results();
        if (found.length > 1) throw new Error(`unique: ${found.length} documents in ${name}`);
        return found[0] ?? null;
      },
      async *[Symbol.asyncIterator]() {
        yield* results();
      },
    };
    return builder;
  }
}

export interface ScheduledJob {
  at: number;
  ref: unknown;
  name: string;
  args: unknown;
}

export interface HarnessOptions {
  /** App functions the component may call back through a function handle, by name. */
  appFunctions?: Record<string, (args: any) => unknown>;
}

export function createHarness(options: HarnessOptions = {}) {
  let now = Date.UTC(2026, 10, 15, 12, 0, 0);
  const clock = () => now;
  // The component reads `Date.now()`; timers stay real so fetch timeouts work.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  function setNow(value: number) {
    now = value;
    vi.setSystemTime(now);
  }
  const db = new FakeDb(clock);
  let scheduled: ScheduledJob[] = [];
  const appFunctions = options.appFunctions ?? {};
  const appCalls: { name: string; args: unknown }[] = [];
  /** Scheduled actions that threw. Convex logs such a failure and runs nothing in its place. */
  const failedActions: { name: string; error: unknown }[] = [];

  /**
   * Runs a scheduled job as Convex does: an action that throws is over, with
   * nothing run in its place, so the test goes on. A mutation that throws is
   * a bug in the component, and fails the test.
   */
  async function runJob(job: ScheduledJob): Promise<void> {
    const { fn } = resolve(job.ref);
    if (fn === null || !fn.isAction) {
      await call(job.ref, job.args);
      return;
    }
    try {
      await call(job.ref, job.args);
    } catch (error) {
      failedActions.push({ name: job.name, error });
    }
  }

  function resolve(ref: unknown): { name: string; fn: Registered | null } {
    const address = getFunctionAddress(ref);
    if (address.functionHandle !== undefined) {
      return { name: address.functionHandle, fn: null };
    }
    let path: string;
    if (address.name !== undefined) {
      path = address.name;
    } else {
      const parts = (address.reference as string).split("/");
      // `_reference/childComponent/herculesAgents/<module>/<function>`
      path = `${parts.slice(3, -1).join("/")}:${parts[parts.length - 1]}`;
    }
    const [moduleName, functionName] = path.split(":") as [string, string];
    const fn = MODULES[moduleName]?.[functionName] as Registered | undefined;
    if (fn === undefined) throw new Error(`No function ${path}`);
    return { name: path, fn };
  }

  const scheduler = {
    async runAfter(delayMs: number, ref: unknown, args: unknown) {
      const { name } = resolve(ref);
      scheduled.push({ at: now + delayMs, ref, name, args: structuredClone(args) });
      return `scheduled:${scheduled.length}`;
    },
    async runAt(at: number, ref: unknown, args: unknown) {
      const { name } = resolve(ref);
      scheduled.push({ at, ref, name, args: structuredClone(args) });
      return `scheduled:${scheduled.length}`;
    },
  };

  const noAuth = { getUserIdentity: async () => null };

  async function call(ref: unknown, args: unknown): Promise<unknown> {
    const { name, fn } = resolve(ref);
    if (fn === null) {
      const appFunction = appFunctions[name.replace(/^function:\/\//, "")];
      if (appFunction === undefined) throw new Error(`No app function for handle ${name}`);
      appCalls.push({ name, args });
      return await appFunction(args);
    }
    const argsJson = JSON.parse(fn.exportArgs()) as Json;
    checkValue(argsJson, structuredClone(args), `${name} args`);
    let result: unknown;
    if (fn.isAction) {
      result = await fn._handler(
        { runQuery: call, runMutation: call, runAction: call, scheduler, auth: noAuth },
        args,
      );
    } else if (fn.isMutation) {
      const tables = structuredClone(db.tables);
      const jobs = [...scheduled];
      try {
        result = await fn._handler(
          { db, scheduler, runQuery: call, runMutation: call, auth: noAuth },
          args,
        );
      } catch (error) {
        db.tables = tables;
        scheduled = jobs;
        throw error;
      }
    } else {
      result = await fn._handler({ db, runQuery: call, auth: noAuth }, args);
    }
    const returns = fn.exportReturns();
    if (returns !== null)
      checkValue(JSON.parse(returns) as Json, result ?? null, `${name} returns`);
    return result;
  }

  // `createFunctionHandle` asks the Convex runtime for a handle; answer like it.
  (globalThis as { Convex?: unknown }).Convex = {
    asyncSyscall: async (op: string, argsJson: string) => {
      if (op !== "1.0/createFunctionHandle") throw new Error(`Unexpected syscall ${op}`);
      const { name } = JSON.parse(argsJson) as { name: string };
      return JSON.stringify(`function://${name}`);
    },
  };

  const component = componentsGeneric()["herculesAgents"] as unknown as ComponentApi;

  return {
    db,
    component,
    get now() {
      return now;
    },
    get scheduled() {
      return scheduled;
    },
    appCalls,
    failedActions,
    runJob,
    clock,
    advance(ms: number) {
      setNow(now + ms);
    },
    /** The context of one of the app's functions, signed in as `tokenIdentifier` or no one. */
    appCtx(tokenIdentifier: string | null = null) {
      const identity =
        tokenIdentifier === null
          ? null
          : ({ tokenIdentifier, subject: tokenIdentifier, issuer: "test" } as UserIdentity);
      return {
        auth: {
          getUserIdentity: async () => identity,
        },
        runQuery: call as never,
        runMutation: call as never,
        runAction: call as never,
      };
    },
    call: call as (ref: FunctionReference<any, any>, args: unknown) => Promise<any>,
    /** Removes and returns the jobs scheduled so far, without running them. */
    takeScheduled(): ScheduledJob[] {
      const jobs = scheduled;
      scheduled = [];
      return jobs;
    },
    /** Runs every job due by now, earliest first, including ones they schedule. */
    async runDue(limit = 100) {
      for (let i = 0; i < limit; i++) {
        const due = scheduled.filter((job) => job.at <= now).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) return;
        scheduled = scheduled.filter((job) => job !== due);
        await runJob(due);
      }
      throw new Error("runDue: too many jobs");
    },
    /** Moves the clock to each scheduled job in turn and runs it, until none is left before `untilMs`. */
    async runUntil(untilMs: number, limit = 200) {
      for (let i = 0; i < limit; i++) {
        const next = scheduled.filter((job) => job.at <= untilMs).sort((a, b) => a.at - b.at)[0];
        if (next === undefined) {
          setNow(Math.max(now, untilMs));
          return;
        }
        setNow(Math.max(now, next.at));
        scheduled = scheduled.filter((job) => job !== next);
        await runJob(next);
      }
      throw new Error("runUntil: too many jobs");
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;
