import { link, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dynamicComponentCreatorPlugin } from "../dynamic-component-creator";

const { actualLink, linkMock } = vi.hoisted(() => ({
  actualLink: { current: undefined as unknown as typeof link },
  linkMock: vi.fn(),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  actualLink.current = actual.link;
  return { ...actual, link: linkMock };
});

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
  linkMock.mockReset();
  linkMock.mockImplementation(actualLink.current);
  root = await mkdtemp(path.join(tmpdir(), "dynamic-component-creator-"));
});

afterEach(async () => {
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

  it("keeps content written by another writer before the stub is linked", async () => {
    linkMock.mockImplementationOnce(async (existingPath: string, newPath: string) => {
      await writeFile(newPath, REAL);
      return actualLink.current(existingPath, newPath);
    });

    await resolve("@/components/pane.tsx");

    const dir = path.join(root, "src", "components");
    expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(REAL);
    expect(await readdir(dir)).toEqual(["pane.tsx"]);
  });

  it.each(["ENOTSUP", "EPERM", "ENOSYS", "EISDIR"])(
    "falls back to an exclusive write when linking fails with %s",
    async (code) => {
      linkMock.mockRejectedValueOnce(Object.assign(new Error(code), { code }));

      await resolve("./components/pane.tsx");

      const dir = path.join(root, "src", "components");
      expect(linkMock).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(dir, "pane.tsx"), "utf8")).toBe(STUB);
      expect(await readdir(dir)).toEqual(["pane.tsx"]);
    },
  );
});
