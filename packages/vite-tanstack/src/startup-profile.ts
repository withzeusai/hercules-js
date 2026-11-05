import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, PluginOption, ResolvedConfig, ViteDevServer } from "vite";

/** Starts the report line, so a log query can find it. */
export const STARTUP_PROFILE_PREFIX = "[hercules:startup-profile]";

/** Hooks that run once, or once per environment, before the dev server answers. */
const STARTUP_HOOKS = [
  "config",
  "configEnvironment",
  "configResolved",
  "configureServer",
  "buildStart",
] as const;

/** Hooks that run once per module. Their time is summed per plugin until the report. */
const MODULE_HOOKS = ["resolveId", "load", "transform"] as const;

/** Installed versions go in the report, so a slower start can be traced to an upgrade. */
const REPORTED_PACKAGES = [
  "vite",
  "@cloudflare/vite-plugin",
  "@tanstack/react-start",
  "@usehercules/vite-tanstack",
];

/** How long after the server starts listening to report anyway. */
const REPORT_DEADLINE_MS = 60_000;

/** How long the first page and the optimizer must stay done before the report. */
const IDLE_MS = 500;

// Keeps the line short enough for herculesd to log it as one record.
const MAX_HOOKS = 20;
const MAX_MODULE_HOOKS = 12;

/** Counts config loads in this process, so a `server.restart()` reports as a later start. */
const STARTS = Symbol.for("@usehercules/vite-tanstack/startup-profile/starts");

export interface StartupProfileReport {
  v: 1;
  /** 1 for the first start in this process, 2 and up after each `server.restart()`. */
  start: number;
  versions: Record<string, string>;
  /** Milliseconds since the process started. */
  marks: {
    configLoad: number;
    pluginsReady?: number;
    configResolved?: number;
    listening?: number;
  };
  /** Milliseconds spent importing each plugin and calling its factory. */
  imports: Record<string, number>;
  /** Entries pre-bundled in each environment. */
  include: Record<string, number>;
  /** Each dependency optimizer run: a scan for imports or a bundle. `at` is since the process started. */
  optimizer: OptimizerRun[];
  /** Startup hooks as `[plugin, hook, ms]`, slowest first. */
  hooks: Array<[string, string, number]>;
  /**
   * Per-module hooks as `[plugin, hook, calls, ms]` up to the report, slowest
   * first. Calls overlap and a hook that calls `this.resolve` includes the
   * plugins it reaches, so these rank plugins rather than add up.
   */
  modules: Array<[string, string, number, number]>;
  /** The first page request, usually herculesd's readiness probe of `/`. */
  firstPage?: { at: number; ms: number; status: number; completed: boolean };
}

interface OptimizerRun {
  env: string;
  kind: "scan" | "bundle";
  at: number;
  ms: number;
}

export interface StartupProfilerOptions {
  /** Vite root, where the app's `node_modules` lives. */
  root: string;
  /** Milliseconds since the process started. */
  now?: () => number;
  /** Writes the report line. Defaults to the dev server's logger. */
  write?: (line: string, server: ViteDevServer) => void;
  /** Schedules the deadline report. Defaults to an unreferenced `setTimeout`. */
  schedule?: (callback: () => void, delayMs: number) => void;
}

export interface StartupProfiler {
  /** Times loading one plugin. */
  step<T>(name: string, load: () => Promise<T>): Promise<T>;
  /** Times every plugin's hooks and puts the reporting plugin first. */
  instrument(plugins: PluginOption[]): Promise<Plugin[]>;
}

type Hook = (this: unknown, ...args: unknown[]) => unknown;

interface Total {
  plugin: string;
  hook: string;
  calls: number;
  ms: number;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** A copy of `fn` that passes each call's duration to `record`, then maps its result. */
function timed(
  fn: Hook,
  now: () => number,
  record: (ms: number) => void,
  after: (result: unknown) => unknown = (result) => result,
): Hook {
  return function (this: unknown, ...args: unknown[]) {
    const startedAt = now();
    const failed = (error: unknown) => {
      record(now() - startedAt);
      throw error;
    };
    let result: unknown;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      return failed(error);
    }
    const done = (value: unknown) => {
      record(now() - startedAt);
      return after(value);
    };
    return isThenable(result) ? Promise.resolve(result).then(done, failed) : done(result);
  };
}

/**
 * Replaces a plugin's hook, in either the function or the `{ handler }` form,
 * keeping `order` and `filter`. The plugin is changed in place because other
 * plugins look each other up by identity. A plugin that cannot be changed is
 * left as it is: profiling must never break the dev server.
 */
function wrapHook(plugin: Plugin, hook: string, wrap: (fn: Hook) => Hook): void {
  const hooks = plugin as unknown as Record<string, unknown>;
  const value = hooks[hook];
  try {
    if (typeof value === "function") {
      hooks[hook] = wrap(value as Hook);
    } else if (typeof (value as { handler?: unknown } | undefined)?.handler === "function") {
      const handler = (value as { handler: Hook }).handler;
      hooks[hook] = { ...(value as object), handler: wrap(handler) };
    }
  } catch {
    // A frozen plugin object.
  }
}

async function flatten(option: PluginOption): Promise<Plugin[]> {
  const value = await option;
  if (!value) return [];
  if (Array.isArray(value)) return (await Promise.all(value.map(flatten))).flat();
  return [value as Plugin];
}

function readVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const name of REPORTED_PACKAGES) {
    try {
      const manifest = path.join(root, "node_modules", name, "package.json");
      const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
      if (typeof version === "string") versions[name] = version;
    } catch {
      // Not installed.
    }
  }
  return versions;
}

function isPage(req: { method?: string; url?: string; headers: { accept?: string } }): boolean {
  if (req.method !== "GET") return false;
  return req.url === "/" || (req.headers.accept ?? "").includes("text/html");
}

function writeToLogger(line: string, server: ViteDevServer): void {
  server.config.logger.info(line);
}

function scheduleUnref(callback: () => void, delayMs: number): void {
  setTimeout(callback, delayMs).unref();
}

/**
 * Profiles a dev server start and logs one line,
 * `[hercules:startup-profile] {...}` ({@link StartupProfileReport}), once the
 * first page is served and the dependency optimizer is idle, or
 * {@link REPORT_DEADLINE_MS} after the server starts listening.
 *
 * Herculesd ships the dev server's output to the platform logs, so the line
 * shows where startup time goes on real dev machines: loading the config,
 * each plugin's startup hooks (the Cloudflare plugin starts workerd in
 * `configureServer`), each optimizer run per environment, and the first
 * server render.
 *
 * Its plugin must be in the config on every start: Vite's dependency cache
 * hash includes the plugin names, so switching it on and off would re-bundle
 * the dependencies each time.
 */
export function startupProfiler({
  root,
  now = () => performance.now(),
  write = writeToLogger,
  schedule = scheduleUnref,
}: StartupProfilerOptions): StartupProfiler {
  const counter = globalThis as typeof globalThis & { [STARTS]?: number };
  const start = (counter[STARTS] = (counter[STARTS] ?? 0) + 1);
  const marks: StartupProfileReport["marks"] = { configLoad: Math.round(now()) };
  const imports: Record<string, number> = {};
  const include: Record<string, number> = {};
  const optimizer: OptimizerRun[] = [];
  const startupTotals = new Map<string, Total>();
  const moduleTotals = new Map<string, Total>();
  let firstPage: StartupProfileReport["firstPage"];
  let pageDone = false;
  let optimizing = 0;
  let reported = false;
  let server: ViteDevServer | undefined;

  const add = (totals: Map<string, Total>, plugin: string, hook: string, ms: number) => {
    const key = `${plugin}\0${hook}`;
    const total = totals.get(key) ?? { plugin, hook, calls: 0, ms: 0 };
    total.calls += 1;
    total.ms += ms;
    totals.set(key, total);
  };

  const slowest = (totals: Map<string, Total>, max: number) =>
    [...totals.values()]
      .filter((total) => total.ms >= 1)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, max);

  const report = () => {
    if (reported || !server) return;
    reported = true;
    try {
      const body: StartupProfileReport = {
        v: 1,
        start,
        versions: readVersions(root),
        marks,
        imports,
        include,
        optimizer,
        hooks: slowest(startupTotals, MAX_HOOKS).map((t) => [t.plugin, t.hook, Math.round(t.ms)]),
        modules: slowest(moduleTotals, MAX_MODULE_HOOKS).map((t) => [
          t.plugin,
          t.hook,
          t.calls,
          Math.round(t.ms),
        ]),
        ...(firstPage ? { firstPage } : {}),
      };
      write(`${STARTUP_PROFILE_PREFIX} ${JSON.stringify(body)}`, server);
    } catch {
      // Never let the report break the dev server.
    }
  };

  // Rechecks after a pause, since a bundle's write starts a moment after its build ends.
  let checking = false;
  const reportWhenIdle = () => {
    if (checking || !pageDone || optimizing > 0) return;
    checking = true;
    schedule(() => {
      checking = false;
      if (pageDone && optimizing === 0) report();
    }, IDLE_MS);
  };

  const optimizerTimer = (env: string) => {
    let run: OptimizerRun | undefined;
    let startedAt = 0;
    const settle = () => {
      if (!run) return;
      run.ms = Math.round(now() - startedAt);
      optimizing -= 1;
      reportWhenIdle();
    };
    return {
      name: "hercules:startup-profile-optimizer",
      buildStart() {
        run = undefined;
        if (reported) return;
        startedAt = now();
        run = { env, kind: "scan", at: Math.round(startedAt), ms: 0 };
        optimizer.push(run);
        optimizing += 1;
      },
      // A scan ends here. A bundle goes on to write its chunks.
      buildEnd: settle,
      renderStart() {
        if (!run) return;
        run.kind = "bundle";
        optimizing += 1;
      },
      writeBundle: settle,
      renderError: settle,
    };
  };

  const reporter: Plugin = {
    name: "hercules:startup-profile",
    apply: "serve",
    enforce: "pre",
    configEnvironment(name) {
      return { optimizeDeps: { rolldownOptions: { plugins: [optimizerTimer(name)] } } };
    },
    configResolved(config: ResolvedConfig) {
      marks.configResolved = Math.round(now());
      for (const [name, environment] of Object.entries(config.environments ?? {})) {
        include[name] = environment.optimizeDeps?.include?.length ?? 0;
      }
    },
    configureServer(devServer) {
      server = devServer;
      devServer.httpServer?.once("listening", () => {
        marks.listening = Math.round(now());
        schedule(report, REPORT_DEADLINE_MS);
      });
      devServer.middlewares.use((req, res, next) => {
        if (firstPage || !isPage(req)) return next();
        const startedAt = now();
        const page = { at: Math.round(startedAt), ms: 0, status: 0, completed: false };
        firstPage = page;
        const done = () => {
          if (pageDone) return;
          pageDone = true;
          page.ms = Math.round(now() - startedAt);
          page.status = res.statusCode;
          page.completed = res.writableFinished === true;
          reportWhenIdle();
        };
        res.once("finish", done);
        res.once("close", done);
        next();
      });
    },
  };

  return {
    async step(name, load) {
      const startedAt = now();
      try {
        return await load();
      } finally {
        imports[name] = Math.round(now() - startedAt);
      }
    },
    async instrument(options) {
      const plugins = (await Promise.all(options.map(flatten))).flat();
      marks.pluginsReady = Math.round(now());
      for (const plugin of plugins) {
        const name = plugin.name;
        for (const hook of STARTUP_HOOKS) {
          const record = (ms: number) => add(startupTotals, name, hook, ms);
          // `configureServer` may return a hook Vite runs after its own middleware.
          const timePostHook = (result: unknown) =>
            typeof result === "function"
              ? timed(result as Hook, now, (ms) => add(startupTotals, name, `${hook}:post`, ms))
              : result;
          wrapHook(plugin, hook, (fn) =>
            timed(fn, now, record, hook === "configureServer" ? timePostHook : undefined),
          );
        }
        for (const hook of MODULE_HOOKS) {
          // After the report a call goes straight to the plugin.
          wrapHook(plugin, hook, (fn) => {
            const profiled = timed(fn, now, (ms) => add(moduleTotals, name, hook, ms));
            return function (this: unknown, ...args: unknown[]) {
              return (reported ? fn : profiled).apply(this, args);
            };
          });
        }
      }
      return [reporter, ...plugins];
    },
  };
}
