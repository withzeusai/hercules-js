/**
 * The package's public surface, held: every entry point in `package.json`
 * and, for each, the exact list of names it exports, values and types. It is
 * the public API "Versioning" in the README describes, so this fails when a
 * change adds, removes or renames one.
 *
 * - Add a name here on purpose, and document it in the README: an export is
 *   something apps come to depend on.
 * - Removing or renaming one breaks the apps that import it, and the
 *   changelog has to say so.
 *
 * It reads what is published, the built `dist`, as the version test in
 * `agents.test.ts` does: `turbo test` builds first, and a package that was
 * never built has nothing to read. The types of the same names are held in
 * `public-surface.test-d.ts`, which needs no build.
 */
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

declare global {
  interface ImportMeta {
    /** Vite's: a loader for each module a pattern matches. */
    glob(pattern: string[]): Record<string, () => Promise<object>>;
  }
}

/** The built declaration files, as text, by their path from here. */
const DECLARATIONS = import.meta.glob(["../../dist/**/*.d.mts", "../../dist/**/*.d.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});
/** The built modules, each loaded when asked for. */
const MODULES = import.meta.glob(["../../dist/*.mjs", "../../dist/component/convex.config.js"]);
const IS_BUILT = Object.keys(DECLARATIONS).length > 0;

interface Surface {
  /** What `import * as entry` holds at run time. */
  values: string[];
  /** What can only be imported as a type. */
  types: string[];
}

const SURFACE: Record<string, Surface> = {
  ".": {
    values: ["RunStreamError", "ToolError", "followRun"],
    types: [
      "AgentEvent",
      "AgentEventOf",
      "AgentEventType",
      "AgentOrigin",
      "CappedReason",
      "EventDataByType",
      "FinalRunStatus",
      "Message",
      "MessagePart",
      "Run",
      "RunError",
      "RunStatus",
      "RunStreamOptions",
      "TextPart",
      "ToolAnnotations",
      "ToolCallPart",
      "ToolCallStatus",
      "ToolCaller",
      "ToolKind",
      "ToolPrincipal",
      "Usage",
    ],
  },
  "./convex": {
    values: ["HerculesAgents", "ToolError", "defineTools", "runFinishedValidator", "tool"],
    types: [
      "ActiveRun",
      "AgentErrorCode",
      "AgentErrorData",
      "AgentOrigin",
      "AgentThread",
      "AgentThreadDetails",
      "ComponentApi",
      "ConvexTool",
      "DefinedTools",
      "HerculesAgentsOptions",
      "PendingPageAction",
      "RunFinished",
      "SendArgs",
      "StoredToolCall",
      "ThreadArgs",
      "ThreadMessage",
      "ToolAnnotations",
      "ToolCaller",
      "ToolCtx",
      "ToolDefinition",
      "ToolPrincipal",
      "ToolsDefinition",
    ],
  },
  "./convex.config": { values: ["default"], types: [] },
  "./react": {
    values: ["AgentError", "RunStreamError", "useAgentThread"],
    types: [
      "AgentThread",
      "AgentThreadStatus",
      "PageActionHandler",
      "SendMutationArgs",
      "UseAgentThreadOptions",
      "UseAgentThreadResult",
      "ViewMessage",
      "ViewPart",
      "ViewToolCallPart",
    ],
  },
  "./tanstack": {
    values: [
      "PAGE_ACTION_OUTPUT",
      "PROGRESS_EVENT",
      "agentErrorCode",
      "herculesConnection",
      "useThreadSync",
    ],
    types: [
      "AgentThread",
      "HerculesAgentApi",
      "HerculesConnection",
      "HerculesConnectionOptions",
      "HerculesConvexClient",
      "HerculesMessageMetadata",
      "HerculesToolOutput",
      "PageActionHandler",
      "PageActionHandlers",
      "SyncableChat",
    ],
  },
  // Types only: Convex's code generation reads `ComponentApi` from this path.
  "./_generated/component": { values: [], types: ["ComponentApi"] },
};

/** Entry points that are a second spelling of another, for Convex's own imports. */
const ALIASES: Record<string, string> = {
  "./convex.config.js": "./convex.config",
  "./_generated/component.js": "./_generated/component",
};

type ExportTarget = string | { types?: string; default?: string };

const NAME = "[A-Za-z_$][\\w$]*";

function targetOf(entry: string): { types: string; code: string | null } {
  const target = (packageJson.exports as Record<string, ExportTarget>)[entry];
  if (target === undefined) throw new Error(`package.json has no export "${entry}"`);
  if (typeof target === "string") {
    return { types: target.replace(/\.mjs$/, ".d.mts"), code: target };
  }
  if (target.types === undefined) throw new Error(`The export "${entry}" names no types`);
  return { types: target.types, code: target.default ?? null };
}

/** A file of the package, as `import.meta.glob` names it from this directory. */
function fromHere(path: string): string {
  return `../../${path.replace(/^\.\//, "")}`;
}

/**
 * The names a built declaration file exports, each as a value or as a type.
 * It reads the forms the build writes and throws on any other, so an export
 * it cannot read is never one it missed.
 */
function declaredExports(file: string): Surface {
  const text = DECLARATIONS[fromHere(file)];
  if (text === undefined) throw new Error(`${file} is not in the build`);
  const values = new Set<string>();
  const types = new Set<string>();
  for (const match of text.matchAll(/^export\b[^\n]*/gm)) {
    const line = match[0];
    const declared = new RegExp(
      `^export (?:declare )?(function|class|const|interface|type) (${NAME})`,
    ).exec(line);
    const list = /^export (type )?\{([^}]*)\};?$/.exec(line);
    if (list !== null) {
      for (const item of list[2]!.split(",")) {
        if (item.trim() === "") continue;
        const named = new RegExp(`^(type )?(${NAME})(?: as (${NAME}))?$`).exec(item.trim());
        if (named === null) throw new Error(`Cannot read the export "${item}" in ${file}`);
        const isType = list[1] !== undefined || named[1] !== undefined;
        (isType ? types : values).add(named[3] ?? named[2]!);
      }
    } else if (declared !== null) {
      const isType = declared[1] === "interface" || declared[1] === "type";
      (isType ? types : values).add(declared[2]!);
    } else {
      throw new Error(`Cannot read the export "${line}" in ${file}`);
    }
  }
  return { values: [...values].sort(), types: [...types].sort() };
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

describe("the package's public surface", () => {
  it("has these entry points and no other", () => {
    expect(sorted(Object.keys(packageJson.exports))).toEqual(
      sorted([...Object.keys(SURFACE), ...Object.keys(ALIASES), "./package.json"]),
    );
    const exports = packageJson.exports as Record<string, ExportTarget>;
    for (const [alias, entry] of Object.entries(ALIASES)) {
      expect(exports[alias]).toEqual(exports[entry]);
    }
  });

  it("keeps each list sorted, so a change to one reads as one line", () => {
    for (const surface of Object.values(SURFACE)) {
      expect(surface.values).toEqual(sorted(surface.values));
      expect(surface.types).toEqual(sorted(surface.types));
    }
  });

  it.skipIf(!IS_BUILT).each(Object.keys(SURFACE))(
    "exports exactly these names from %s",
    async (entry) => {
      const expected = SURFACE[entry]!;
      const target = targetOf(entry);
      expect(declaredExports(target.types)).toEqual(expected);
      // What the types declare as values is what the code exports, name for name.
      if (target.code === null) {
        expect(expected.values).toEqual([]);
        return;
      }
      const load = MODULES[fromHere(target.code)];
      if (load === undefined) throw new Error(`${target.code} is not in the build`);
      expect(sorted(Object.keys(await load()))).toEqual(expected.values);
    },
  );
});
