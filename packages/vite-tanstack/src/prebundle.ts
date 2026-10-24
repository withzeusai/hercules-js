import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";

/**
 * Entries that a package name alone does not cover, bundled up front on top
 * of the app's dependencies: template packages the app imports by subpath, and
 * a dependency of TanStack Router, which loads from source. Each is kept only
 * when the app declares its package.
 */
export const PREBUNDLED_ENTRIES: readonly string[] = [
  "@tanstack/react-router > @tanstack/react-store",
  "@usehercules/auth-tanstack/client",
  "@usehercules/auth-tanstack/convex",
  "convex/react",
  "convex/server",
  "convex/values",
  "@hookform/resolvers/zod",
  "motion/react",
];

/** Server-only entries, on top of {@link PREBUNDLED_ENTRIES}. */
export const SSR_PREBUNDLED_ENTRIES: readonly string[] = ["convex/browser"];

/**
 * Dependencies never bundled up front. Vite and TanStack Start already include
 * React. Start loads its own and the router's packages from source, so the app
 * and Start's virtual modules share one router; Start also lists them in
 * `optimizeDeps.exclude`, which the plugin honours for anything else.
 */
const NEVER_PREBUNDLED: ReadonlySet<string> = new Set([
  "react",
  "react-dom",
  "@tanstack/react-start",
  "@tanstack/react-router",
  "@tanstack/react-router-devtools",
]);

/**
 * Dependencies of packages that ship a native addon. The optimizer cannot
 * bundle a `.node` binary, and one failing entry fails the whole run, which
 * leaves the dev server without any pre-bundled dependency.
 */
const NATIVE_ADDON_LOADERS: ReadonlySet<string> = new Set([
  "bindings",
  "nan",
  "node-addon-api",
  "node-gyp-build",
  "node-pre-gyp",
  "@mapbox/node-pre-gyp",
  "prebuild-install",
]);

/** Platform builds of a napi-rs or sharp style package, such as `@img/sharp-linux-x64`. */
const PLATFORM_PACKAGE = /-(?:darwin|linux|win32|freebsd|android)-(?:x64|arm64|arm|ia32)\b/;

/** Matches what Vite's optimizer accepts as an entry, minus type declarations. */
const JS_ENTRY = /\.[cm]?[jt]s$/;
const TYPE_DECLARATION = /\.d\.[cm]?ts$/;

const LOCKFILES: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: unknown;
  module?: unknown;
  main?: unknown;
  browser?: unknown;
  gypfile?: unknown;
  binary?: unknown;
}

function readManifest(file: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * The package that owns an `optimizeDeps.include` entry:
 * `@scope/name/sub > nested` gives `@scope/name`.
 */
export function packageNameOf(entry: string): string {
  const first = entry.split(">")[0]!.trim();
  const parts = first.split("/");
  return first.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The dependency names the app's `package.json` declares, or `undefined` if it cannot be read. */
export function readDeclaredDependencies(root: string): Set<string> | undefined {
  const pkg = readManifest(path.join(root, "package.json"));
  if (!pkg) return undefined;
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

/**
 * Keeps the entries whose package the app declares. An app that removes a
 * template package must not get "Failed to resolve dependency" on every start.
 */
export function onlyDeclared(
  entries: readonly string[],
  declared: Set<string> | undefined,
): string[] {
  if (!declared) return [...entries];
  return entries.filter((entry) => declared.has(packageNameOf(entry)));
}

/** Every file path a conditional `exports` target can point at. */
function exportTargets(target: unknown): string[] {
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) return target.flatMap(exportTargets);
  if (target && typeof target === "object") return Object.values(target).flatMap(exportTargets);
  return [];
}

function isJsEntry(file: string): boolean {
  return JS_ENTRY.test(file) && !TYPE_DECLARATION.test(file);
}

/**
 * Whether `import "name"` loads JavaScript. A CSS-only package such as a
 * font, a types-only package, or one that exports only subpaths has nothing
 * the optimizer can bundle under its bare name.
 */
function hasJsRootEntry(manifest: Manifest, packageDir: string): boolean {
  const { exports } = manifest;
  if (exports !== undefined && exports !== null) {
    if (typeof exports === "string" || Array.isArray(exports)) {
      return exportTargets(exports).some(isJsEntry);
    }
    if (typeof exports === "object") {
      const keys = Object.keys(exports);
      const isSubpathMap = keys.some((key) => key.startsWith("."));
      const root = isSubpathMap ? (exports as Record<string, unknown>)["."] : exports;
      return exportTargets(root).some(isJsEntry);
    }
  }
  for (const field of [manifest.module, manifest.main]) {
    if (typeof field !== "string" || field === "") continue;
    // `"main": "lib/index"` resolves like a bare path, so only reject a
    // field that names a file of another type.
    return isJsEntry(field) || path.extname(field) === "";
  }
  if (typeof manifest.browser === "string") return isJsEntry(manifest.browser);
  return existsSync(path.join(packageDir, "index.js"));
}

/** Whether the package loads a compiled `.node` addon. */
function hasNativeAddon(manifest: Manifest): boolean {
  if (manifest.gypfile === true || manifest.binary !== undefined) return true;
  const dependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  return dependencies.some((name) => NATIVE_ADDON_LOADERS.has(name) || PLATFORM_PACKAGE.test(name));
}

/** Extensions a bare-name lookup from the project root tries. */
const ROOT_LOOKUP_EXTENSIONS: readonly string[] = [
  "",
  ".json",
  ".js",
  ".mjs",
  ".ts",
  ".mts",
  ".jsx",
  ".tsx",
];

/**
 * Whether a file or directory in the project root has the package's name.
 * With `resolve.tsconfigPaths`, a bare name is looked up from the root first,
 * so `convex` resolves to the app's `convex.json`, and the optimizer warns
 * "Cannot optimize dependency" on every start.
 */
function isShadowedByProjectPath(root: string, name: string): boolean {
  return ROOT_LOOKUP_EXTENSIONS.some((extension) => existsSync(path.join(root, name + extension)));
}

/**
 * The app's runtime `dependencies` that can be bundled up front, read from
 * the installed packages. A dependency that is declared but not installed yet
 * is left out until it is, so a restart in the middle of an install does not
 * drop it with a "Failed to resolve dependency" warning.
 */
export function dependenciesToPrebundle(root: string): string[] {
  const pkg = readManifest(path.join(root, "package.json"));
  const names = Object.keys(pkg?.dependencies ?? {}).sort();
  return names.filter((name) => {
    if (NEVER_PREBUNDLED.has(name) || name.startsWith("@types/")) return false;
    if (isShadowedByProjectPath(root, name)) return false;
    const packageDir = path.join(root, "node_modules", name);
    const manifest = readManifest(path.join(packageDir, "package.json"));
    if (!manifest) return false;
    return hasJsRootEntry(manifest, packageDir) && !hasNativeAddon(manifest);
  });
}

/**
 * Source files scanned for imports when the Worker environment starts, on top
 * of the server entries TanStack Start and the Cloudflare plugin list. Routes
 * load lazily, so without this the optimizer meets a package first when a page
 * that imports it renders on the server.
 */
export function sourceEntries(srcDir: string): string[] {
  const dir = srcDir.replace(/\/+$/, "");
  return [
    `${dir}/**/*.{js,jsx,ts,tsx,mjs,mts}`,
    `!${dir}/**/*.d.{ts,mts}`,
    `!${dir}/**/*.{test,spec,stories}.{js,jsx,ts,tsx,mjs,mts}`,
    `!${dir}/**/__tests__/**`,
    `!${dir}/**/__mocks__/**`,
  ];
}

export interface PrebundleOptions {
  /** Vite root, where the app's `package.json` and `node_modules` live. */
  root: string;
  /** Application source directory, relative to the root. */
  srcDir: string;
  /** Read `dependencies` from `package.json` and bundle them up front. */
  dependencies: boolean;
  /** Extra entries for both environments. */
  extra: readonly string[];
}

function entriesFor(
  environment: "client" | "ssr",
  options: PrebundleOptions,
  dependencies: readonly string[],
): string[] {
  const declared = readDeclaredDependencies(options.root);
  return [
    ...dependencies,
    ...onlyDeclared(PREBUNDLED_ENTRIES, declared),
    ...(environment === "ssr" ? onlyDeclared(SSR_PREBUNDLED_ENTRIES, declared) : []),
    ...options.extra,
  ];
}

/** Drops entries whose package the environment excludes from optimization. */
function withoutExcluded(entries: string[], exclude: readonly string[] | undefined): string[] {
  if (!exclude?.length) return entries;
  const excluded = new Set(exclude);
  return entries.filter((entry) => !excluded.has(entry) && !excluded.has(packageNameOf(entry)));
}

function isManifestOrLockfile(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "package.json" || LOCKFILES.includes(relative);
}

const RESTART_DEBOUNCE_MS = 1000;
// pnpm can write package.json before the new package is linked. Keep checking
// for a while so a package that lands late is still picked up.
const INSTALL_POLL_MS = 1000;
const INSTALL_POLL_LIMIT = 60;

function isInstalled(root: string, name: string): boolean {
  return existsSync(path.join(root, "node_modules", name, "package.json"));
}

interface HotSender {
  send(...args: unknown[]): void;
}

/**
 * Restarts the dev server with its HMR messages muted. Until the new server
 * listens, a message from the old one (a reload for a route file the agent
 * wrote meanwhile) sends the browser to a port that is about to close, and
 * the page stays on a connection error. Browsers reload by themselves once
 * the new server accepts their socket. A failed restart keeps the old server,
 * so it gets its messages back.
 */
function restartQuietly(server: ViteDevServer): Promise<void> {
  const { environments } = server;
  const channels: HotSender[] = [
    server.ws,
    ...Object.values(environments).map((environment) => environment.hot),
  ];
  const sends = channels.map((channel) => [channel, channel.send] as const);
  for (const [channel] of sends) channel.send = () => {};
  return server.restart().finally(() => {
    if (server.environments !== environments) return;
    for (const [channel, send] of sends) channel.send = send;
  });
}

/**
 * Restarts the dev server when the dependencies it would bundle differ from
 * `started`, the list the running server was configured with.
 */
function watchDependencies(server: ViteDevServer, root: string, started: readonly string[]): void {
  const startedKey = started.join("\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polls = 0;
  let restarting = false;

  const check = () => {
    timer = undefined;
    if (restarting) return;
    if (dependenciesToPrebundle(root).join("\n") !== startedKey) {
      restarting = true;
      server.config.logger.info(
        "[hercules] dependencies changed; restarting the dev server to pre-bundle them",
        { timestamp: true },
      );
      void restartQuietly(server);
      return;
    }
    const declared = Object.keys(readManifest(path.join(root, "package.json"))?.dependencies ?? {});
    const pending = declared.some((name) => !isInstalled(root, name));
    if (pending && polls < INSTALL_POLL_LIMIT) {
      polls += 1;
      timer = setTimeout(check, INSTALL_POLL_MS);
    }
  };

  const schedule = (file: string) => {
    if (!isManifestOrLockfile(root, file)) return;
    polls = 0;
    clearTimeout(timer);
    timer = setTimeout(check, RESTART_DEBOUNCE_MS);
  };

  server.watcher.add([
    path.join(root, "package.json"),
    ...LOCKFILES.map((file) => path.join(root, file)),
  ]);
  server.watcher.on("add", schedule);
  server.watcher.on("change", schedule);
  server.httpServer?.once("close", () => clearTimeout(timer));
}

/**
 * Bundles the app's dependencies up front in the browser and the Worker
 * (`ssr`) environment, so Vite does not discover a package mid-session.
 *
 * A package Vite discovers while the app runs makes it bundle the
 * dependencies again. In the browser that changes their version hash: modules
 * still being fetched with the old hash fail with 504 "Outdated Optimize Dep"
 * ("Failed to fetch dynamically imported module" for a lazily loaded route),
 * then the page reloads. In the Worker it can load a second React copy and
 * break server rendering until a restart.
 *
 * So every runtime dependency the app declares is bundled when the server
 * starts, minus packages that cannot be (CSS or types only, native addons, or
 * excluded by another plugin), and the Worker scans the whole source tree
 * rather than only the server entries. When `package.json` or the lockfile
 * changes, the dev server restarts so a package the agent just installed is
 * bundled before any code imports it.
 */
export function prebundleDependencies(options: PrebundleOptions): Plugin {
  // Read once per server start, so both environments and the watcher agree.
  let dependencies: string[] | undefined;
  const configuredDependencies = () =>
    (dependencies ??= options.dependencies ? dependenciesToPrebundle(options.root) : []);

  return {
    name: "hercules:prebundle-dependencies",
    apply: "serve",
    // After TanStack Start and the Cloudflare plugin, so their excludes are known.
    enforce: "post",
    configEnvironment(name, config) {
      if (name !== "client" && name !== "ssr") return;
      const entries = entriesFor(name, options, configuredDependencies());
      return {
        optimizeDeps: {
          include: withoutExcluded(entries, config.optimizeDeps?.exclude),
          ...(name === "ssr" ? { entries: sourceEntries(options.srcDir) } : {}),
        },
      };
    },
    configureServer(server) {
      if (options.dependencies) watchDependencies(server, options.root, configuredDependencies());
    },
  };
}
