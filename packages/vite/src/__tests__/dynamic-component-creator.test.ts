import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const linkMock = vi.hoisted(() => vi.fn());

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  linkMock.mockImplementation(actual.link);
  return { ...actual, link: linkMock };
});

const { dynamicComponentCreatorPlugin } = await import("../dynamic-component-creator");

const STUB = `import React from "react";\n\nexport default function Pane(_props: unknown) {\n  return <div></div>;\n}\n`;
const REAL = `export default function Pane() {\n  return <section>real content</section>;\n}\n`;

let root: string;

async function resolve(source: string) {
  const plugin = dynamicComponentCreatorPlugin({ force: true });
  (plugin.configResolved as (config: { root: string }) => void)({ root });
  const resolveId = plugin.resolveId as {
    handler: (source: string, importer: string, options: object) => Promise<unknown>;
  };
  return resolveId.handler(source, path.join(root, "src", "App.tsx"), {});
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dynamic-component-creator-"));
});

afterEach(async () => {
  vi.mocked(linkMock).mockClear();
  await rm(root, { recursive: true, force: true });
});

describe("dynamicComponentCreatorPlugin", () => {
  it("creates a stub for a missing component", async () => {
    await resolve("./components/pane.tsx");

    const dir = path.join(root, "src", "components");
    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(STUB);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });

  it("leaves an existing component untouched", async () => {
    const dir = path.join(root, "src", "components");
    await resolve("./components/pane.tsx");
    await writeFile(path.join(dir, "pane.tsx"), REAL);

    await resolve("./components/pane.tsx");

    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(REAL);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });

  it("preserves content written by another writer during stub creation", async () => {
    const { link } = await vi.importActual<typeof import("fs/promises")>("fs/promises");
    linkMock.mockImplementationOnce(async (existingPath: string, newPath: string) => {
      await writeFile(newPath, REAL);
      return link(existingPath, newPath);
    });

    await resolve("@/components/pane.tsx");

    const dir = path.join(root, "src", "components");
    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(REAL);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });

  it("falls back to an exclusive write when hard links are unsupported", async () => {
    linkMock.mockRejectedValueOnce(Object.assign(new Error("not supported"), { code: "ENOTSUP" }));

    await resolve("./components/pane.tsx");

    const dir = path.join(root, "src", "components");
    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(STUB);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });
});
