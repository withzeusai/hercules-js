import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Test helpers, exported as `@usehercules/vite-common/testing` for the tests
// of the packages that bundle vite-common. Nothing outside tests imports it.

/** A project root with a package.json and the given installed packages. */
export function appRoot(
  dependencies: Record<string, string>,
  installed: Record<string, Record<string, unknown>> = {},
): string {
  const root = mkdtempSync(path.join(tmpdir(), "vite-common-prebundle-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies }));
  for (const [name, manifest] of Object.entries(installed)) install(root, name, manifest);
  return root;
}

export function install(root: string, name: string, manifest: Record<string, unknown>): void {
  const dir = path.join(root, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
}

export function declare(root: string, dependencies: Record<string, string>): void {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies }));
}

export const lib = { main: "index.js" };
