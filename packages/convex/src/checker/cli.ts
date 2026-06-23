#!/usr/bin/env node
import { checkIamSource, formatIamCheckResult } from "./index.js";

type ParsedArgs =
  | {
      ok: true;
      convexDir?: string;
      json: boolean;
      fixAuthenticated: boolean;
      help: boolean;
    }
  | { ok: false; message: string };

const parsedArgs = parseArgs(process.argv.slice(2));

if (!parsedArgs.ok) {
  console.error(parsedArgs.message);
  console.error(helpText());
  process.exitCode = 2;
} else if (parsedArgs.help) {
  console.log(helpText());
} else {
  const result = checkIamSource({
    cwd: process.cwd(),
    convexDir: parsedArgs.convexDir,
    fixAuthenticated: parsedArgs.fixAuthenticated,
  });

  if (parsedArgs.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatIamCheckResult(result));
  }

  process.exitCode = result.ok ? 0 : 1;
}

function parseArgs(args: string[]): ParsedArgs {
  let convexDir: string | undefined;
  let json = false;
  let fixAuthenticated = false;
  let help = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--fix-authenticated") {
      fixAuthenticated = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Unknown option: ${arg}` };
    }
    if (convexDir) {
      return { ok: false, message: `Unexpected argument: ${arg}` };
    }
    convexDir = arg;
  }

  return { ok: true, convexDir, json, fixAuthenticated, help };
}

function helpText(): string {
  return [
    "Usage: hercules-convex-iam-check [convex-dir] [--json] [--fix-authenticated]",
    "",
    "Checks exported Convex functions for raw query(), mutation(), or action()",
    "builders that should use Hercules IAM builders from convex/iam.ts.",
    "Also checks common managed organization mistakes such as placeholder scope ids,",
    "app-local org membership tables, unsafe org slug lookups, existing-row resource scopes,",
    "row capability checks without a concrete resource,",
    "and iam* permission keys that are not declared in hercules/iam.jsonc.",
    "Apps that do not use the @usehercules/convex IAM SDK in their Convex",
    "functions pass unchanged: raw Convex builders stay allowed there.",
    "",
    "--fix-authenticated rewrites exported raw builders to authenticated* builders",
    "as a conservative migration starting point. Review public and permissioned",
    "handlers afterward and switch them to public* or iam* deliberately.",
  ].join("\n");
}
