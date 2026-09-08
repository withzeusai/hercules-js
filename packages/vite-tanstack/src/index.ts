import path from "node:path";
import {
  mergeConfig,
  type ConfigEnv,
  type PluginOption,
  type UserConfig,
  type UserConfigExport,
  type UserConfigFnPromise,
} from "vite";
import type { HerculesPluginOptions } from "@usehercules/vite";
import type { Options as ReactPluginOptions } from "@vitejs/plugin-react";
import type { PluginConfig as CloudflarePluginConfig } from "@cloudflare/vite-plugin";
import type { TanStackDevtoolsViteConfig } from "@tanstack/devtools-vite";
import type { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { herculesAliases } from "./aliases";

export type { Alias } from "vite";
export { herculesAliases, type AliasDirs } from "./aliases";

/** Options accepted by `tanstackStart()` from `@tanstack/react-start/plugin/vite`. */
export type TanStackStartPluginOptions = NonNullable<Parameters<typeof tanstackStart>[0]>;

const PACKAGE_NAME = "@usehercules/vite-tanstack";

/**
 * Set to `"true"` by the Hercules dev machine. It is the same signal
 * `@usehercules/vite` already reads, so one variable switches every
 * sandbox-only behaviour on.
 */
export const HERCULES_DEV_SERVER_ENV = "HERCULES_DEV_SERVER";

export function isHerculesDevServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERCULES_DEV_SERVER_ENV] === "true";
}

/**
 * Directories written by agents and tooling rather than by the app. Changes
 * there must never trigger an HMR update or a full reload.
 */
export const TOOL_MANAGED_WATCH_IGNORES: readonly string[] = [
  "**/.agents/**",
  "**/.claude/**",
  "**/.hercules/**",
  "**/.tanstack/tmp/**",
  "**/.workspace/**",
  "**/.wrangler/**",
];

/** Packages that must resolve to a single copy or React and TanStack break at runtime. */
export const DEDUPE: readonly string[] = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@tanstack/react-query",
  "@tanstack/query-core",
  "@tanstack/react-router",
];

const OPTIMIZE_DEPS_INCLUDE: readonly string[] = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

export interface HerculesTanStackConfigOptions {
  /** Extra Vite plugins, appended after the Hercules plugin stack. */
  plugins?: PluginOption[];

  /**
   * Vite options merged over the generated config. Anything set here wins
   * over the defaults, so this is the escape hatch for one-off tweaks.
   */
  vite?: UserConfig;

  /**
   * Application source directory, relative to the Vite root. Mapped to `@`.
   * @default "src"
   */
  srcDir?: string;

  /**
   * Convex functions directory, relative to the Vite root. Mapped to
   * `@/convex`. Pass `false` for apps without Convex.
   * @default "convex"
   */
  convexDir?: string | false;

  /** Options forwarded to `@vitejs/plugin-react`. */
  react?: ReactPluginOptions;

  /** Options forwarded to `tanstackStart()`. */
  tanstackStart?: TanStackStartPluginOptions;

  /**
   * Options forwarded to `@cloudflare/vite-plugin`. The plugin targets the
   * `ssr` environment so the TanStack Start server runs in workerd during
   * dev and builds into a Worker. Pass `false` to build without it.
   */
  cloudflare?: CloudflarePluginConfig | false;

  /**
   * Options forwarded to `@usehercules/vite`. Pass `false` to leave the
   * Hercules dev tooling (component tagger, visual editor, error forwarding)
   * out of the stack.
   */
  hercules?: HerculesPluginOptions | false;

  /** Options forwarded to `@tanstack/devtools-vite`. Pass `false` to skip it. */
  devtools?: TanStackDevtoolsViteConfig | false;

  /**
   * Whether to include `@tailwindcss/vite`.
   * @default true
   */
  tailwind?: boolean;
}

const OPTION_KEYS: ReadonlySet<string> = new Set<keyof HerculesTanStackConfigOptions>([
  "vite",
  "srcDir",
  "convexDir",
  "react",
  "tanstackStart",
  "cloudflare",
  "hercules",
  "devtools",
  "tailwind",
]);

function logWarning(message: string): void {
  console.warn(`[${PACKAGE_NAME}] ${message}`);
}

function isModuleNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    (typeof message === "string" && /Cannot find (module|package)/.test(message))
  );
}

/**
 * Import an optional peer. When the user configured it explicitly a missing
 * package is an error; otherwise it is skipped with a warning so an app that
 * dropped the dependency on purpose still starts.
 */
async function importOptional<T>(
  specifier: string,
  load: () => Promise<T>,
  explicit: boolean,
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    if (explicit) {
      throw new Error(
        `[${PACKAGE_NAME}] \`${specifier}\` is configured in vite.config.ts but is not installed. Add it to devDependencies.`,
        { cause: error },
      );
    }
    logWarning(`\`${specifier}\` is not installed; skipping it.`);
    return undefined;
  }
}

async function normalizeOptions(
  config: HerculesTanStackConfigOptions | UserConfigExport | undefined,
  env: ConfigEnv,
): Promise<HerculesTanStackConfigOptions> {
  if (config === undefined) return {};
  if (typeof config === "function") return { vite: await config(env) };
  if (config instanceof Promise) return { vite: await config };
  const isOptions = Object.keys(config).some((key) => OPTION_KEYS.has(key));
  return isOptions ? (config as HerculesTanStackConfigOptions) : { vite: config as UserConfig };
}

/**
 * Build the Vite plugin stack. Everything is imported lazily so a disabled
 * plugin costs nothing at config load and optional peers stay optional.
 */
async function buildPlugins(options: HerculesTanStackConfigOptions): Promise<PluginOption[]> {
  const plugins: PluginOption[] = [];

  if (options.devtools !== false) {
    const mod = await importOptional(
      "@tanstack/devtools-vite",
      () => import("@tanstack/devtools-vite"),
      options.devtools !== undefined,
    );
    if (mod) plugins.push(mod.devtools(options.devtools));
  }

  if (options.tailwind !== false) {
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    plugins.push(tailwindcss());
  }

  if (options.hercules !== false) {
    const { hercules } = await import("@usehercules/vite");
    plugins.push(hercules(options.hercules));
  }

  if (options.cloudflare !== false) {
    const mod = await importOptional(
      "@cloudflare/vite-plugin",
      () => import("@cloudflare/vite-plugin"),
      options.cloudflare !== undefined,
    );
    if (mod) {
      plugins.push(mod.cloudflare({ viteEnvironment: { name: "ssr" }, ...options.cloudflare }));
    }
  }

  const { tanstackStart } = await import("@tanstack/react-start/plugin/vite");
  plugins.push(tanstackStart(options.tanstackStart));

  const { default: react } = await import("@vitejs/plugin-react");
  plugins.push(react(options.react));

  if (options.plugins) plugins.push(...options.plugins);
  return plugins;
}

/**
 * Base config shared by every Hercules TanStack Start app. Kept separate from
 * `defineConfig` so the Vitest helper can reuse the same aliases.
 */
export function herculesBaseConfig(
  options: HerculesTanStackConfigOptions,
  { sandbox = isHerculesDevServer() }: { sandbox?: boolean } = {},
): UserConfig {
  const root = path.resolve(options.vite?.root ?? process.cwd());
  const { srcDir = "src", convexDir = "convex" } = options;

  return {
    resolve: {
      alias: herculesAliases({ root, srcDir, convexDir }),
      dedupe: [...DEDUPE],
    },
    optimizeDeps: {
      include: [...OPTIMIZE_DEPS_INCLUDE],
    },
    build: {
      chunkSizeWarningLimit: 1000,
    },
    server: {
      // The Hercules preview proxies to the dev server from another origin,
      // and the platform captures errors itself, so the overlay stays off.
      host: "0.0.0.0",
      port: 5173,
      allowedHosts: true,
      hmr: { overlay: false },
      ...(sandbox
        ? {
            // The platform routes to a fixed port; falling back to another
            // would leave the preview pointing at nothing.
            strictPort: true,
            watch: {
              ignored: [...TOOL_MANAGED_WATCH_IGNORES],
              // Agents write files in bursts. Wait for a file to settle so a
              // half-written module never reaches the browser.
              awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
            },
          }
        : {}),
    },
  };
}

/**
 * Vite config for a Hercules TanStack Start app.
 *
 * Accepts either the same values as Vite's own `defineConfig` (an object,
 * promise, or function) which are merged over the Hercules defaults, or a
 * {@link HerculesTanStackConfigOptions} object to tune the individual plugins.
 *
 * @example
 * ```ts
 * import { defineConfig } from "@usehercules/vite-tanstack";
 * export default defineConfig();
 * ```
 */
export function defineConfig(
  config?: HerculesTanStackConfigOptions | UserConfigExport,
): UserConfigFnPromise {
  return async (env) => {
    const options = await normalizeOptions(config, env);
    const base = herculesBaseConfig(options);
    base.plugins = await buildPlugins(options);
    return options.vite ? mergeConfig(base, options.vite) : base;
  };
}

export default defineConfig;
