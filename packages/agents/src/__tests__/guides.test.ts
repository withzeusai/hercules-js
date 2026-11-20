/**
 * The guides under `docs/`, held to the package, so that none of them can
 * rot:
 *
 * - Every TypeScript sample in a guide is a file under `fixtures/guides`, or
 *   a run of lines of one, word for word. Those files are an app as the
 *   guides write it, and the type-check compiles them against this source
 *   (`tsconfig.test.json` reads the package's name as `src`), so a sample
 *   that stops compiling fails `pnpm test`. `guides.test-d.ts` holds what
 *   they come to.
 * - The README links each guide and names its path in the package, and the
 *   package ships them.
 * - Nothing in the package points at the Hercules docs site, whose pages on
 *   the agents API are gone: what a developer needs is said here.
 */
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

declare global {
  interface ImportMeta {
    /** Vite's: the files a pattern matches, as text. */
    glob(
      pattern: string[],
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

function byName(files: Record<string, string>, root: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [path.slice(root.length), text]),
  );
}

/** The guides, by file name. */
const GUIDES = byName(
  import.meta.glob(["../../docs/*.md"], { query: "?raw", import: "default", eager: true }),
  "../../docs/",
);
/** The guides' app, by its path in that app: `convex/agent.ts`. */
const APP = byName(
  import.meta.glob(["./fixtures/guides/**/*.ts", "./fixtures/guides/**/*.tsx"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  "./fixtures/guides/",
);
const README = Object.values(
  import.meta.glob(["../../README.md"], { query: "?raw", import: "default", eager: true }),
)[0] as string;
const CHANGELOG = Object.values(
  import.meta.glob(["../../CHANGELOG.md"], { query: "?raw", import: "default", eager: true }),
)[0] as string;
/** What ships as source and in the declarations: its doc comments and its messages. */
const SOURCE = import.meta.glob(["../*.ts", "../component/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const GUIDE_NAMES = ["chat.md", "convex.md", "events-and-errors.md", "tools.md"];

interface Sample {
  guide: string;
  /** `sample`: a whole file. `excerpt`: lines of one. Null for a block with no marker. */
  kind: "sample" | "excerpt" | null;
  file: string | null;
  language: string;
  code: string;
}

/** The fenced blocks of a guide, each with the marker comment before it. */
function blocksOf(guide: string, text: string): Sample[] {
  const blocks: Sample[] = [];
  const fence = /(?:^<!-- (sample|excerpt): (\S+) -->\n\n)?^```(\w+)\n([\s\S]*?)\n```$/gm;
  for (const match of text.matchAll(fence)) {
    blocks.push({
      guide,
      kind: (match[1] as Sample["kind"]) ?? null,
      file: match[2] ?? null,
      language: match[3]!,
      code: match[4]!,
    });
  }
  return blocks;
}

const BLOCKS = Object.entries(GUIDES).flatMap(([guide, text]) => blocksOf(guide, text));
const CODE = BLOCKS.filter(({ language }) => language === "ts" || language === "tsx");

/** A heading's anchor, as GitHub makes it. */
function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replaceAll(" ", "-");
}

function anchorsOf(markdown: string): Set<string> {
  // Outside code: a `#` line in a sample is a comment, not a heading.
  const prose = markdown.replace(/^```[\s\S]*?^```$/gm, "");
  return new Set([...prose.matchAll(/^#{1,6} (.+)$/gm)].map((match) => anchorOf(match[1]!)));
}

/** Where the package's directory is on GitHub, from `repository` in `package.json`. */
function repositoryUrl(): string {
  const { url, directory } = packageJson.repository;
  return `${url.replace(/^git\+/, "").replace(/\.git$/, "")}/blob/main/${directory}`;
}

describe("the guides", () => {
  it("are these four, and the package ships them", () => {
    expect(Object.keys(GUIDES).sort()).toEqual(GUIDE_NAMES);
    expect(packageJson.files).toContain("docs");
    // `repository.directory` is what places the package's files in the repository.
    expect(packageJson.repository.directory).toBe("packages/agents");
  });

  it("mark every TypeScript sample with the file it is", () => {
    expect(CODE.length).toBeGreaterThan(0);
    expect(
      CODE.filter(({ kind }) => kind === null).map(({ guide, code }) => [guide, code]),
    ).toEqual([]);
    // An indented fence is not read above, so a sample is never written in a list.
    for (const [guide, text] of Object.entries(GUIDES)) {
      expect([guide, /^[ \t]+```tsx?$/m.test(text)]).toEqual([guide, false]);
    }
  });

  it.each(CODE.map((block) => [block.guide, block.kind, block.file, block] as const))(
    "%s: the %s of %s is that file's text",
    (_guide, kind, file, block) => {
      const source = APP[file!];
      if (source === undefined) throw new Error(`fixtures/guides has no ${file}`);
      expect(block.language).toBe(file!.endsWith(".tsx") ? "tsx" : "ts");
      if (kind === "sample") {
        expect(block.code).toBe(source.trimEnd());
      } else {
        // Whole lines of the file, in a row.
        expect(`\n${source}`).toContain(`\n${block.code}\n`);
      }
    },
  );

  it("import the package by its name, as an app does", () => {
    const imports = CODE.flatMap(({ code }) =>
      [...code.matchAll(/from "(@usehercules\/[^"]+)"/g)].map((match) => match[1]!),
    );
    expect([...new Set(imports)].sort()).toEqual([
      "@usehercules/agents",
      "@usehercules/agents/convex",
      "@usehercules/agents/react",
      "@usehercules/agents/tanstack",
    ]);
    // Each is an entry point of the package.
    for (const name of imports) {
      const entry =
        name === "@usehercules/agents" ? "." : `.${name.slice("@usehercules/agents".length)}`;
      expect(Object.keys(packageJson.exports)).toContain(entry);
    }
  });

  it("link each other, and the README, by paths and headings that exist", () => {
    const anchors: Record<string, Set<string>> = { "../README.md": anchorsOf(README) };
    for (const [guide, text] of Object.entries(GUIDES)) anchors[`./${guide}`] = anchorsOf(text);
    const broken: string[] = [];
    let links = 0;
    for (const [guide, text] of Object.entries(GUIDES)) {
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const [target, anchor] = match[1]!.split("#") as [string, string | undefined];
        // The guides link nothing outside the package.
        const known = anchors[target];
        links++;
        if (known === undefined || (anchor !== undefined && !known.has(anchor))) {
          broken.push(`${guide}: ${match[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
    expect(links).toBeGreaterThan(GUIDE_NAMES.length);
  });
});

describe("the README's links to the guides", () => {
  it("names each guide by its address on GitHub, and by its path in the package", () => {
    for (const guide of GUIDE_NAMES) {
      expect(README).toContain(`](${repositoryUrl()}/docs/${guide})`);
      expect(README).toContain(`\`docs/${guide}\``);
    }
  });

  it("links a guide's heading only when the guide has it", () => {
    const linked = [
      ...README.matchAll(/\]\(https:\/\/github\.com\/[^)\s]*\/docs\/([\w-]+\.md)(?:#([\w-]+))?\)/g),
    ];
    expect(linked.length).toBeGreaterThanOrEqual(GUIDE_NAMES.length);
    for (const [link, guide, anchor] of linked) {
      const text = GUIDES[guide!];
      if (text === undefined)
        throw new Error(`The README links ${link}, and docs/ has no ${guide}`);
      expect(link).toContain(`](${repositoryUrl()}/docs/`);
      if (anchor !== undefined) expect([link, anchorsOf(text).has(anchor)]).toEqual([link, true]);
    }
  });

  it("has no relative link: the npm page would resolve one against the repository's root", () => {
    // The package is in `packages/agents`, so `./docs/chat.md` would lead
    // nowhere from the page npm renders. Every link is absolute, or is to a
    // heading of the README itself.
    const relative = [...README.matchAll(/\]\((?!https?:\/\/|#)([^)\s]+)\)/g)].map(
      (match) => match[1],
    );
    expect(relative).toEqual([]);
  });
});

describe("the Hercules docs site", () => {
  it("is linked from nowhere in the package", () => {
    const texts: Record<string, string> = {
      "README.md": README,
      "CHANGELOG.md": CHANGELOG,
      ...Object.fromEntries(Object.entries(GUIDES).map(([name, text]) => [`docs/${name}`, text])),
      ...SOURCE,
    };
    expect(Object.keys(SOURCE).length).toBeGreaterThan(20);
    const pointing = Object.entries(texts)
      .filter(([, text]) => /hercules\.app\/docs|docs\.hercules\.app/.test(text))
      .map(([name]) => name);
    expect(pointing).toEqual([]);
    for (const field of ["homepage", "bugs"] as const) {
      expect(JSON.stringify((packageJson as Record<string, unknown>)[field] ?? "")).not.toContain(
        "hercules.app/docs",
      );
    }
  });
});
