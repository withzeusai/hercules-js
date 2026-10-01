import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dynamicComponentCreatorPlugin } from "../dynamic-component-creator";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, link: vi.fn(actual.link) };
});

const STUB = `import React from "react";\n\nexport default function Pane(_props: unknown) {\n  return <div></div>;\n}\n`;
const REAL = `export default function Pane() {\n  return <section>real content</section>;\n}\n`;

let root: string;
let dir: string;

async function resolve(source: string) {
  const plugin = dynamicComponentCreatorPlugin();
  (plugin.configResolved as (config: { root: string }) => void)({ root });
  const resolveId = plugin.resolveId as {
    handler: (source: string, importer: string, options: object) => Promise<unknown>;
  };
  return resolveId.handler(source, path.join(root, "src", "App.tsx"), {});
}

beforeEach(async () => {
  vi.mocked(link).mockReset();
  root = await mkdtemp(path.join(tmpdir(), "dynamic-component-creator-"));
  dir = path.join(root, "src", "components");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dynamicComponentCreatorPlugin", () => {
  it("creates a stub for a missing component", async () => {
    await resolve("./components/pane.tsx");

    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(STUB);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });

  it("leaves an existing component untouched", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "pane.tsx"), REAL);

    await resolve("./components/pane.tsx");

    expect(link).not.toHaveBeenCalled();
    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(REAL);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });

  it("keeps content written by another writer before the stub is linked", async () => {
    const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
    vi.mocked(link).mockImplementationOnce(async (existingPath, newPath) => {
      await writeFile(newPath, REAL);
      return actual.link(existingPath, newPath);
    });

    await resolve("@/components/pane.tsx");

    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(REAL);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });

  it("falls back to an exclusive write when hard links are unsupported", async () => {
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error("ENOSYS"), { code: "ENOSYS" }));

    await resolve("./components/pane.tsx");

    expect(link).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(STUB);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });
});
