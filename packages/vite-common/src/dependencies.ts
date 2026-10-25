import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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

export interface Manifest {
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

export function readManifest(file: string): Manifest | undefined {
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
 * the installed packages, minus the names in `never`. A dependency that is
 * declared but not installed yet is left out until it is, so a restart in the
 * middle of an install does not drop it with a "Failed to resolve dependency"
 * warning.
 */
export function dependenciesToPrebundle(root: string, never: ReadonlySet<string>): string[] {
  const pkg = readManifest(path.join(root, "package.json"));
  const names = Object.keys(pkg?.dependencies ?? {}).sort();
  return names.filter((name) => {
    if (never.has(name) || name.startsWith("@types/")) return false;
    if (isShadowedByProjectPath(root, name)) return false;
    const packageDir = path.join(root, "node_modules", name);
    const manifest = readManifest(path.join(packageDir, "package.json"));
    if (!manifest) return false;
    return hasJsRootEntry(manifest, packageDir) && !hasNativeAddon(manifest);
  });
}

export interface ExportedSubpathsOptions {
  /** Leaves out a subpath, given as its export map key, such as `./internals/noop`. */
  exclude?: (subpath: string) => boolean;
}

/**
 * The subpath entries an installed package publishes in its `exports` map,
 * such as `@base-ui/react/dialog` for `"./dialog"`. A package that ships one
 * entry per component has each one treated as its own package by the
 * optimizer, so listing them all covers a component the app starts using
 * later. Left out: the root entry (a dependency like any other), pattern keys
 * such as `./*`, and subpaths that load no JavaScript, such as
 * `./package.json` or a stylesheet. Returns nothing when the package is not
 * installed.
 */
export function exportedSubpaths(
  root: string,
  name: string,
  { exclude }: ExportedSubpathsOptions = {},
): string[] {
  const manifest = readManifest(path.join(root, "node_modules", name, "package.json"));
  const { exports } = manifest ?? {};
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) return [];
  return Object.entries(exports as Record<string, unknown>)
    .filter(
      ([key, target]) =>
        key.startsWith("./") &&
        !key.includes("*") &&
        !exclude?.(key) &&
        exportTargets(target).some(isJsEntry),
    )
    .map(([key]) => `${name}/${key.slice(2)}`);
}

/** Drops entries whose package the environment excludes from optimization. */
export function withoutExcluded(
  entries: string[],
  exclude: readonly string[] | undefined,
): string[] {
  if (!exclude?.length) return entries;
  const excluded = new Set(exclude);
  return entries.filter((entry) => !excluded.has(entry) && !excluded.has(packageNameOf(entry)));
}

export interface SourceEntriesOptions {
  /**
   * Scan server modules too: `*.server.*` files and the `server` directory.
   * An environment that never runs them leaves them out, so their Node-only
   * imports never become optimizer entries.
   * @default true
   */
  serverFiles?: boolean;
}

/**
 * `optimizeDeps.entries` globs for every source file under `srcDir`, minus
 * tests, stories and type declarations. Routes load lazily, so scanning only
 * the entry's static imports would meet a package first when a page that
 * imports it renders.
 */
export function sourceEntries(
  srcDir: string,
  { serverFiles = true }: SourceEntriesOptions = {},
): string[] {
  const dir = srcDir.replace(/\/+$/, "");
  return [
    `${dir}/**/*.{js,jsx,ts,tsx,mjs,mts}`,
    `!${dir}/**/*.d.{ts,mts}`,
    `!${dir}/**/*.{test,spec,stories}.{js,jsx,ts,tsx,mjs,mts}`,
    `!${dir}/**/__tests__/**`,
    `!${dir}/**/__mocks__/**`,
    ...(serverFiles ? [] : [`!${dir}/**/*.server.{js,jsx,ts,tsx,mjs,mts}`, `!${dir}/server/**`]),
  ];
}
