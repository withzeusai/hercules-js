import path from "node:path";
import type { Alias } from "vite";

export interface AliasDirs {
  /** Absolute project root. */
  root: string;
  /** Application source directory, relative to `root`. Mapped to `@`. */
  srcDir: string;
  /** Convex functions directory, relative to `root`. Mapped to `@/convex`. `false` skips it. */
  convexDir: string | false;
}

/**
 * Path aliases shared by the Vite and Vitest configs.
 *
 * Order matters: Vite tries aliases in array order and `@` would otherwise
 * swallow `@/convex/...` imports and point them at `src/convex`. Keeping the
 * more specific `@/convex` entry first mirrors the `paths` block every
 * Hercules app carries in its `tsconfig.json`.
 */
export function herculesAliases({ root, srcDir, convexDir }: AliasDirs): Alias[] {
  const aliases: Alias[] = [];
  if (convexDir !== false) {
    aliases.push({ find: "@/convex", replacement: path.resolve(root, convexDir) });
  }
  aliases.push({ find: "@", replacement: path.resolve(root, srcDir) });
  return aliases;
}
