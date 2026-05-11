#!/usr/bin/env node
import {
  checkAccessControlSource,
  formatAccessControlCheckResult,
} from "./index.js";

type ParsedArgs =
  | {
      ok: true;
      convexDir?: string;
      json: boolean;
      fixAuthenticated: boolean;
      help: boolean;
    }
  | {
      ok: false;
      message: string;
    };

const parsedArgs = parseArgs(process.argv.slice(2));

if (!parsedArgs.ok) {
  console.error(parsedArgs.message);
  console.error(helpText());
  process.exitCode = 2;
} else if (parsedArgs.help) {
  console.log(helpText());
} else {
  const result = checkAccessControlSource({
    cwd: process.cwd(),
    convexDir: parsedArgs.convexDir,
    fixAuthenticated: parsedArgs.fixAuthenticated,
  });

  if (parsedArgs.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAccessControlCheckResult(result));
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
      return {
        ok: false,
        message: `Unknown option: ${arg}`,
      };
    }
    if (convexDir) {
      return {
        ok: false,
        message: `Unexpected argument: ${arg}`,
      };
    }
    convexDir = arg;
  }

  return {
    ok: true,
    convexDir,
    json,
    fixAuthenticated,
    help,
  };
}

function helpText(): string {
  return [
    "Usage: hercules-convex-access-check [convex-dir] [--json] [--fix-authenticated]",
    "",
    "Checks exported Convex functions for raw query(), mutation(), or action()",
    "builders that should use Hercules Access Control builders from convex/access.ts.",
    "",
    "--fix-authenticated rewrites exported raw builders to authenticated* builders",
    "as a conservative migration starting point. Review public and permissioned",
    "handlers afterward and switch them to public* or access* deliberately.",
  ].join("\n");
}
