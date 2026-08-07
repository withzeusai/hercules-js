import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveComponentId } from "./component-id";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "hercules-id-"));
  root = path.join(base, "project");
  outside = path.join(base, "outside");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, "src", "App.tsx"), "export const A = () => null;\n");
  await writeFile(path.join(root, "src", "App.jsx"), "export const A = () => null;\n");
  await writeFile(path.join(root, "package.json"), "{}\n");
  await writeFile(path.join(outside, "Secret.tsx"), "export const S = () => null;\n");
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe("resolveComponentId", () => {
  it("resolves a project-relative component ID", async () => {
    const result = await resolveComponentId("src/App.tsx:12:4", root);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({
      filePath: path.join(await realRoot(), "src", "App.tsx"),
      line: 12,
      column: 4,
    });
  });

  it("accepts a column of 0", async () => {
    const result = await resolveComponentId("src/App.tsx:1:0", root);

    expect(result.ok && result.value.column).toBe(0);
  });

  it("accepts .jsx as well as .tsx", async () => {
    expect((await resolveComponentId("src/App.jsx:1:0", root)).ok).toBe(true);
  });

  // The component ID arrives in a POST body, so traversal here is arbitrary
  // file read/write on the developer's machine.
  it.each([
    ["../outside/Secret.tsx:1:0", "parent traversal"],
    ["src/../../outside/Secret.tsx:1:0", "traversal through a valid prefix"],
    ["./../outside/Secret.tsx:1:0", "traversal after a leading dot"],
  ])("rejects %s (%s)", async (componentId) => {
    const result = await resolveComponentId(componentId, root);

    expect(result).toEqual({
      ok: false,
      error: "Component ID resolves outside the project root",
    });
  });

  // Lexical containment alone passes this: the path looks internal, but
  // readFile/writeFile follow the link out of the project.
  it("rejects a path that leaves the root through a symlinked directory", async () => {
    await symlink(outside, path.join(root, "linked"), "dir");

    const result = await resolveComponentId("linked/Secret.tsx:1:0", root);

    expect(result).toEqual({
      ok: false,
      error: "Component ID resolves outside the project root",
    });
  });

  it("rejects a symlinked file pointing out of the root", async () => {
    await symlink(path.join(outside, "Secret.tsx"), path.join(root, "src", "Linked.tsx"));

    const result = await resolveComponentId("src/Linked.tsx:1:0", root);

    expect(result).toEqual({
      ok: false,
      error: "Component ID resolves outside the project root",
    });
  });

  it("allows a symlink that stays inside the root", async () => {
    await symlink(path.join(root, "src", "App.tsx"), path.join(root, "Alias.tsx"));

    expect((await resolveComponentId("Alias.tsx:1:0", root)).ok).toBe(true);
  });

  it("rejects an absolute path", async () => {
    const result = await resolveComponentId(`${path.join(outside, "Secret.tsx")}:1:0`, root);

    expect(result).toEqual({ ok: false, error: "Component ID must be a project-relative path" });
  });

  it("rejects a Windows-style absolute path", async () => {
    expect((await resolveComponentId("C:\\Windows\\evil.tsx:1:0", root)).ok).toBe(false);
  });

  it("rejects a NUL byte, which would truncate the path inside libc", async () => {
    const result = await resolveComponentId("src/App.tsx\0/../../etc/hosts:1:0", root);

    expect(result).toEqual({ ok: false, error: "Invalid component ID" });
  });

  it("rejects files the tagger never tags", async () => {
    const result = await resolveComponentId("package.json:1:0", root);

    expect(result).toEqual({
      ok: false,
      error: "Component ID must point at a .jsx or .tsx file",
    });
  });

  it("rejects a file that does not exist", async () => {
    const result = await resolveComponentId("src/Missing.tsx:1:0", root);

    expect(result).toEqual({ ok: false, error: "Component not found: src/Missing.tsx" });
  });

  it("rejects the root directory itself", async () => {
    expect((await resolveComponentId(".:1:0", root)).ok).toBe(false);
  });

  it.each([
    ["src/App.tsx", "no location"],
    ["src/App.tsx:12", "no column"],
    ["", "empty"],
    ["src/App.tsx:0:0", "line below 1"],
  ])("rejects malformed ID %s (%s)", async (componentId) => {
    expect((await resolveComponentId(componentId, root)).ok).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}]])("rejects non-string ID %s", async (componentId) => {
    expect((await resolveComponentId(componentId, root)).ok).toBe(false);
  });
});

/** macOS puts temp dirs behind /private, so compare against the canonical root. */
async function realRoot(): Promise<string> {
  const { realpath } = await import("fs/promises");
  return realpath(root);
}
