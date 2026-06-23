/**
 * Publish every package that has a `jsr.json` to JSR (https://jsr.io).
 *
 * Runs `jsr publish` in each package directory. `jsr publish` is idempotent: it
 * skips any version that is already published, so this is safe to run on every
 * release. From GitHub Actions with `id-token: write`, authentication happens
 * automatically via OIDC (no token needed) and provenance is attached.
 *
 * Any extra CLI args are forwarded to `jsr publish`, e.g.:
 *   node scripts/jsr-publish.mjs --dry-run
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const JSR_VERSION = "0.14.3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const passthrough = process.argv.slice(2);

const packages = globSync("packages/*/jsr.json", { cwd: repoRoot })
  .map((rel) => join(repoRoot, dirname(rel)))
  .sort();

if (packages.length === 0) {
  console.error("No packages/*/jsr.json found.");
  process.exit(1);
}

const failures = [];

for (const cwd of packages) {
  console.log(`\n=== jsr publish: ${cwd} ===`);
  const result = spawnSync("pnpm", ["dlx", `jsr@${JSR_VERSION}`, "publish", ...passthrough], {
    cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failures.push(cwd);
  }
}

if (failures.length > 0) {
  console.error(`\nJSR publish failed for:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log("\nAll JSR packages published (or already up to date).");
