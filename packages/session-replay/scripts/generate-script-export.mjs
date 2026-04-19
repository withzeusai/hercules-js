/**
 * Post-build script to generate a module that exports the ESM script as a string.
 * This allows bundlers (esbuild, Vite, etc.) to import the script content directly.
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distBrowserDir = join(__dirname, "../dist/browser");

const esmContent = readFileSync(join(distBrowserDir, "auto-init.js"), "utf-8");

const wrapperContent = `// Auto-generated - do not edit
// This module exports the ESM session replay script as a string for embedding

/** The minified ESM session replay script content */
export const script = ${JSON.stringify(esmContent)};

export default script;
`;

writeFileSync(join(distBrowserDir, "script-content.mjs"), wrapperContent);

const dtsContent = `// Auto-generated - do not edit

/** The minified ESM session replay script content */
export declare const script: string;

export default script;
`;

writeFileSync(join(distBrowserDir, "script-content.d.mts"), dtsContent);

console.log("\u2713 Generated script-content.mjs and script-content.d.mts");
