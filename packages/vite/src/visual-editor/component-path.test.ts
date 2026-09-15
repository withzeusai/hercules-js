import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ResolvedConfig } from "vite";
import { dynamicComponentCreatorPlugin } from "../dynamic-component-creator";
import { analyzeElement } from "./ast-analyzer";
import { deleteComponent, updateComponentElement } from "./ast-transformer";
import { resolveComponentPath } from "./component-path";

test("visual editor confines file access while preserving normal edits", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "visual-editor-paths-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  const outside = path.join(temp, "project-private");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(outside);
  const source = 'export const App = () => <div className="before">Hello</div>;';
  const file = path.join(root, "src", "App.tsx");
  const secret = path.join(outside, "Secret.tsx");
  await writeFile(file, source);
  await writeFile(secret, source);
  await symlink(outside, path.join(root, "escape"), "dir");
  await symlink(secret, path.join(root, "secret.tsx"));
  await symlink(file, path.join(root, "alias.tsx"));
  await symlink(root, path.join(temp, "linked-project"), "dir");

  for (const candidate of [
    "../project-private/Secret.tsx",
    "src/../../project-private/Secret.tsx",
    secret,
    "C:\\outside\\Secret.tsx",
    "\\\\server\\share\\Secret.tsx",
    "escape/Secret.tsx",
    "secret.tsx",
    ".",
    "src/App.tsx\0",
  ]) {
    await t.test(`rejects ${JSON.stringify(candidate)}`, async () => {
      await assert.rejects(resolveComponentPath(root, candidate));
      const id = `${candidate}:1:24`;
      assert.equal((await analyzeElement(id, root)).success, false);
      assert.equal((await updateComponentElement(id, { className: "owned" }, root)).success, false);
      assert.equal((await deleteComponent(id, root)).success, false);
      assert.equal(await readFile(secret, "utf8"), source);
      assert.equal(await readFile(file, "utf8"), source);
    });
  }

  await t.test("allows project files and symlinks that stay within the root", async () => {
    assert.equal(await resolveComponentPath(root, "src/App.tsx"), await realpath(file));
    assert.equal(await resolveComponentPath(root, "alias.tsx"), await realpath(file));
    assert.equal(
      await resolveComponentPath(path.join(temp, "linked-project"), "src/App.tsx"),
      await realpath(file),
    );
    const id = "src/App.tsx:1:24";
    assert.equal((await analyzeElement(id, root)).success, true);
    assert.equal((await updateComponentElement(id, { className: "after" }, root)).success, true);
    assert.match(await readFile(file, "utf8"), /className="after"/);
    assert.equal((await deleteComponent(id, root)).success, true);
    assert.doesNotMatch(await readFile(file, "utf8"), /<div/);
  });
});

test("automatic component creation stays inside the project", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "component-creation-paths-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  const outside = path.join(temp, "project-private");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(root, "escape"), "dir");
  await symlink(path.join(outside, "missing"), path.join(root, "dangling"), "dir");
  await symlink(path.join(root, "src"), path.join(root, "alias"), "dir");
  await symlink(root, path.join(temp, "linked-project"), "dir");

  const create = async (source: string, aliasBase = "src", projectRoot = root) => {
    const plugin = dynamicComponentCreatorPlugin({ aliasBase });
    assert.equal(typeof plugin.configResolved, "function");
    assert.ok(plugin.resolveId && typeof plugin.resolveId === "object");
    if (typeof plugin.configResolved !== "function") throw new Error("Missing config hook");
    plugin.configResolved.call({} as never, { root: projectRoot } as ResolvedConfig);
    return plugin.resolveId.handler.call(
      {} as never,
      source,
      path.join(projectRoot, "src", "App.tsx"),
      { isEntry: false },
    );
  };

  for (const [source, aliasBase] of [
    ["../../project-private/nested/Escape.tsx", "src"],
    ["@/../../project-private/nested/Escape.tsx", "src"],
    ["../escape/nested/Escape.tsx", "src"],
    ["../dangling/nested/Escape.tsx", "src"],
    ["@/Escape.tsx", outside],
  ]) {
    await t.test(`does not create external files for ${source} (${aliasBase})`, async () => {
      assert.equal(await create(source!, aliasBase), null);
      assert.deepEqual(await readdir(outside), []);
    });
  }

  await t.test(
    "preserves existing files and creates valid nested, aliased and linked-root imports",
    async () => {
      const existing = path.join(root, "src", "Existing.tsx");
      await writeFile(existing, "keep existing contents");
      await create("./Existing.tsx");
      assert.equal(await readFile(existing, "utf8"), "keep existing contents");
      await create("./nested/New-card.tsx");
      assert.match(
        await readFile(path.join(root, "src/nested/New-card.tsx"), "utf8"),
        /function NewCard\(/,
      );
      await create("@/Aliased.tsx");
      await access(path.join(root, "src/Aliased.tsx"));
      await create("../alias/Linked.tsx");
      await access(path.join(root, "src/Linked.tsx"));
      await create("./LinkedRoot.tsx", "src", path.join(temp, "linked-project"));
      await access(path.join(root, "src/LinkedRoot.tsx"));
    },
  );
});
