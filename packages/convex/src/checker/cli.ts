#!/usr/bin/env node
import { checkIamSource, formatIamCheckResult } from "./index.js";

type ParsedArgs =
  | {
      ok: true;
      convexDir?: string;
      json: boolean;
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
  let help = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
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

  return { ok: true, convexDir, json, help };
}

function helpText(): string {
  return [
    "Usage: hercules-convex-iam-check [convex-dir] [--json]",
    "",
    "Validates the Convex source against the app's .hercules/iam.jsonc catalog.",
    "Permission literals (the `permission` option on protectedQuery/protectedMutation/",
    "protectedAction and the argument to access.hasPermissions / access.requirePermissions,",
    "a single key, an array, or an anyOf/allOf set) must be a declared app permission.",
    "Resource-type literals in resource refs",
    "(the `resource` option and resource.write / resource.get / resource.list)",
    "must be a declared resource type. Dynamic, non-literal values are skipped.",
    "",
    "Apps without a .hercules/iam.jsonc catalog pass unchanged.",
  ].join("\n");
}
