/**
 * Sync each package's `jsr.json` version from its `package.json`.
 *
 * `package.json` (driven by Changesets) is the single source of truth for
 * versions. JSR reads the version from `jsr.json`, so this script copies the
 * version across. It runs as part of `changeset:version`, so the "version
 * packages" PR keeps both files in lockstep.
 *
 * Exits non-zero if any file is out of sync when run with `--check`, which lets
 * CI verify the two never drift.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const checkOnly = process.argv.includes("--check");

const jsrConfigs = globSync("packages/*/jsr.json", { cwd: repoRoot }).sort();

let drift = false;

for (const relConfig of jsrConfigs) {
  const jsrPath = join(repoRoot, relConfig);
  const pkgPath = join(dirname(jsrPath), "package.json");

  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const raw = readFileSync(jsrPath, "utf8");
  const jsr = JSON.parse(raw);

  if (jsr.version === pkg.version) continue;

  if (checkOnly) {
    drift = true;
    console.error(`✗ ${relConfig}: version ${jsr.version} != package.json ${pkg.version}`);
    continue;
  }

  jsr.version = pkg.version;
  // Preserve the trailing newline of the original file.
  const trailing = raw.endsWith("\n") ? "\n" : "";
  writeFileSync(jsrPath, JSON.stringify(jsr, null, 2) + trailing);
  console.log(`✓ ${relConfig} -> ${pkg.version}`);
}

if (checkOnly && drift) {
  console.error("\njsr.json versions are out of sync. Run: pnpm sync:jsr");
  process.exit(1);
}
