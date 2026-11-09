import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { nativeAddonsExternal } from "./native-addons";
import { appRoot, install } from "./testing";

function writeFile(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * `ssh2-sftp-client` > `ssh2` > `cpu-features`, as pnpm installs them without
 * running build scripts: `cpu-features` requires an addon that was never built.
 */
function installSftpClient(modules: string): void {
  install(path.dirname(modules), "sftp-client", { main: "index.js", dependencies: { ssh: "*" } });
  writeFile(path.join(modules, "sftp-client/index.js"), 'module.exports = require("ssh");');
  install(path.dirname(modules), "ssh", {
    main: "index.js",
    optionalDependencies: { "cpu-features": "*" },
  });
  writeFile(
    path.join(modules, "ssh/index.js"),
    'let cpu;\ntry { cpu = require("cpu-features")(); } catch {}\nmodule.exports = { cpu };',
  );
  install(path.dirname(modules), "cpu-features", { main: "lib/index.js" });
  writeFile(
    path.join(modules, "cpu-features/lib/index.js"),
    'module.exports = require("../build/Release/cpufeatures.node").getCPUInfo;',
  );
}

/**
 * Bundles `entry.js` with Rolldown, as the optimizer does. The optimizer runs
 * `optimizeDeps.rolldownOptions.plugins` before its own resolver, so the
 * plugins run first here too.
 */
async function bundle(root: string, plugins: Rolldown.Plugin[]): Promise<string> {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: plugins.map((plugin) => ({ ...plugin, enforce: "pre" as const })),
    build: { write: false, lib: { entry: path.join(root, "entry.js"), formats: ["es"] } },
  });
  const [output] = Array.isArray(result) ? result : [result];
  return (output as Rolldown.RolldownOutput).output[0].code;
}

describe("nativeAddonsExternal", () => {
  it("bundles a package whose dependency requires an addon that was never built", async () => {
    const root = appRoot({ "sftp-client": "*" });
    installSftpClient(path.join(root, "node_modules"));
    writeFile(path.join(root, "entry.js"), 'export { default } from "sftp-client";');

    await expect(bundle(root, [])).rejects.toThrow("cpufeatures.node");
    expect(await bundle(root, [nativeAddonsExternal()])).toContain(
      '"./node_modules/cpu-features/build/Release/cpufeatures.node"',
    );
  });

  it("finds the addon next to the real directory of a linked package", async () => {
    const root = appRoot({ "sftp-client": "*" });
    const store = path.join(root, "node_modules/.pnpm/sftp-client@1.0.0/node_modules");
    installSftpClient(store);
    symlinkSync(path.join(store, "sftp-client"), path.join(root, "node_modules/sftp-client"));
    writeFile(path.join(root, "entry.js"), 'export { default } from "sftp-client";');

    expect(await bundle(root, [nativeAddonsExternal()])).toContain(
      '"./node_modules/.pnpm/sftp-client@1.0.0/node_modules/cpu-features/build/Release/cpufeatures.node"',
    );
  });

  it("keeps an addon that was built external", async () => {
    const root = appRoot({ "sftp-client": "*" });
    installSftpClient(path.join(root, "node_modules"));
    writeFile(path.join(root, "node_modules/cpu-features/build/Release/cpufeatures.node"), "\0");
    writeFile(path.join(root, "entry.js"), 'export { default } from "sftp-client";');

    expect(await bundle(root, [nativeAddonsExternal()])).toContain(
      '"./node_modules/cpu-features/build/Release/cpufeatures.node"',
    );
  });

  it("bundles a script whose name ends in .node, as react-dom/server loads it", async () => {
    const root = appRoot({});
    writeFile(path.join(root, "server.node.js"), "module.exports = { renderToString() {} };");
    writeFile(path.join(root, "entry.js"), 'export { default } from "./server.js";');
    writeFile(path.join(root, "server.js"), 'module.exports = require("./server.node");');

    const code = await bundle(root, [nativeAddonsExternal()]);
    expect(code).toContain("renderToString");
    expect(code).not.toContain("server.node");
  });

  it("still fails on a missing file that is not an addon", async () => {
    const root = appRoot({});
    writeFile(path.join(root, "entry.js"), 'export * from "./missing.js";');
    await expect(bundle(root, [nativeAddonsExternal()])).rejects.toThrow("missing.js");
  });
});
