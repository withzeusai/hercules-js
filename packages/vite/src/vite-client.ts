import type { TransformResult } from "vite";

/**
 * Helpers for injecting dev-only client scripts without `transformIndexHtml`.
 *
 * SPA apps have an `index.html`, so Vite's `transformIndexHtml` hook is a
 * natural place to add a script tag. Server-rendered frameworks such as
 * TanStack Start never call that hook: the HTML is produced by the app's own
 * server entry. What every dev page does load, in both setups, is Vite's own
 * client (`/@vite/client`), which resolves to `vite/dist/client/client.mjs`
 * and passes through the plugin `transform` pipeline like any other module.
 * Appending a dynamic import to it is therefore a reliable way to get a
 * script onto every page served by the dev server.
 */

/** Whether `id` is Vite's dev client module, the carrier for injected scripts. */
export function isViteClientModule(id: string): boolean {
  return id.replace(/\\/g, "/").includes("/vite/dist/client/client.mjs");
}

/**
 * Whether a `transform` call targets the browser. Vite 6+ exposes the
 * environment on the hook context; older callers only pass `options.ssr`.
 */
export function isClientTransform(
  ctx: { environment?: { name: string } },
  options?: { ssr?: boolean },
): boolean {
  if (options?.ssr) return false;
  const name = ctx.environment?.name;
  return name === undefined || name === "client";
}

/** Append `import(specifier)` to a module so the browser loads it alongside. */
export function appendClientImport(code: string, specifier: string): TransformResult {
  return { code: `${code}\nimport(${JSON.stringify(specifier)});\n`, map: null };
}
