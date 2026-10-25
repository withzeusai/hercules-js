import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Every package the template ships, bundled up front in both environments so
 * Vite never re-optimizes them mid-session. On the server a re-optimization
 * loads a second React copy and breaks SSR until a restart. The optimizer
 * only finds a package the first time a page that imports it renders, so the
 * list covers them all, not only the ones the starter page uses: the first
 * route that adds a form or an animation would otherwise trigger it. It
 * matches what `node_modules/.vite/deps_ssr/_metadata.json` holds after a full
 * build, minus the React entries Start adds itself.
 */
export const PREBUNDLED_PACKAGES: readonly string[] = [
  "@tanstack/react-query",
  "@tanstack/react-router-ssr-query",
  "@tanstack/react-router > @tanstack/react-store",
  "@convex-dev/react-query",
  "@usehercules/auth-tanstack",
  "@usehercules/auth-tanstack/client",
  "@usehercules/auth-tanstack/convex",
  "convex/react",
  "convex/server",
  "convex/values",
  "@hookform/resolvers/zod",
  "class-variance-authority",
  "clsx",
  "cmdk",
  "date-fns",
  "embla-carousel-react",
  "input-otp",
  "lucide-react",
  "motion/react",
  "radix-ui",
  "react-day-picker",
  "react-hook-form",
  "react-resizable-panels",
  "recharts",
  "sonner",
  "tailwind-merge",
  "use-debounce",
  "vaul",
  "zod",
];

/** Server-only entries, on top of {@link PREBUNDLED_PACKAGES}. */
export const SSR_PREBUNDLED_PACKAGES: readonly string[] = ["convex/browser"];

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
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return undefined;
  }
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
