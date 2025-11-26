/**
 * Post-build script to generate a module that exports the IIFE script as a string.
 * This allows bundlers (esbuild, Vite, etc.) to import the script content directly.
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distBrowserDir = join(__dirname, "../dist/browser");

// Read the IIFE script
const iifeContent = readFileSync(join(distBrowserDir, "index.iife.js"), "utf-8");

// Generate wrapper module that exports the script as a string
const wrapperContent = `// Auto-generated - do not edit
// This module exports the IIFE analytics script as a string for embedding

/** The minified IIFE analytics script content */
export const script = ${JSON.stringify(iifeContent)};

export default script;
`;

// Write the wrapper module
writeFileSync(join(distBrowserDir, "script-content.mjs"), wrapperContent);

// Also generate TypeScript declaration
const dtsContent = `// Auto-generated - do not edit

/** The minified IIFE analytics script content */
export declare const script: string;

export default script;
`;

writeFileSync(join(distBrowserDir, "script-content.d.mts"), dtsContent);

console.log("✓ Generated script-content.mjs and script-content.d.mts");

