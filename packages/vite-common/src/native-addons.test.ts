import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";
import { build, type Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import {
  nativeAddonsExternal,
  nativeAddonsExternalEsbuild,
  nativeAddonsOptimizerOptions,
} from "./native-addons";
import { appRoot, install } from "./testing";

function writeFile(file: string, contents: string | Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * A napi-rs package, as `@napi-rs/canvas` ships: it requires the build for
 * the current platform by package name, inside `try`.
 */
function installNapiPackage(root: string): void {
  install(root, "canvas", { main: "index.js" });
  writeFile(
    path.join(root, "node_modules/canvas/index.js"),
    'let binding;\ntry { binding = require("canvas-linux-x64-gnu"); } catch {}\nmodule.exports = { binding };',
  );
}

/** The platform build `installNapiPackage` requires, whose `main` is the binary addon. */
function installPlatformBuild(root: string): void {
  install(root, "canvas-linux-x64-gnu", { main: "skia.linux-x64-gnu.node" });
  // ELF magic, then bytes that are not valid UTF-8, so the optimizer cannot read it.
  writeFile(
    path.join(root, "node_modules/canvas-linux-x64-gnu/skia.linux-x64-gnu.node"),
    Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 0xff, 0xfe),
  );
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

  it("keeps a platform build whose main is the addon external", async () => {
    const root = appRoot({ canvas: "*" });
    installNapiPackage(root);
    installPlatformBuild(root);
    writeFile(path.join(root, "entry.js"), 'export { default } from "canvas";');

    await expect(bundle(root, [])).rejects.toThrow("skia.linux-x64-gnu.node");
    expect(await bundle(root, [nativeAddonsExternal()])).toContain(
      path.join(root, "node_modules/canvas-linux-x64-gnu/skia.linux-x64-gnu.node"),
    );
  });

  it("leaves a platform build that is not installed to the default resolution", async () => {
    const root = appRoot({ canvas: "*" });
    installNapiPackage(root);
    writeFile(path.join(root, "entry.js"), 'export { default } from "canvas";');

    expect(await bundle(root, [nativeAddonsExternal()])).toBe(await bundle(root, []));
  });

  it("bundles a platform build whose main is a script", async () => {
    const root = appRoot({ "tool-linux-x64": "*" });
    install(root, "tool-linux-x64", { main: "index.js" });
    writeFile(path.join(root, "node_modules/tool-linux-x64/index.js"), "module.exports = 42;");
    writeFile(path.join(root, "entry.js"), 'export { default } from "tool-linux-x64";');

    const code = await bundle(root, [nativeAddonsExternal()]);
    expect(code).toContain("42");
    expect(code).not.toContain('from "');
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

/** Bundles `entry.js` with esbuild, as the Vite 7 optimizer does, plugins first. */
async function bundleWithEsbuild(root: string, plugins: esbuild.Plugin[]): Promise<string> {
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(root, "entry.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
    plugins,
  });
  return result.outputFiles[0]?.text ?? "";
}

describe("nativeAddonsExternalEsbuild", () => {
  it("bundles a package whose dependency requires an addon that was never built", async () => {
    const root = appRoot({ "sftp-client": "*" });
    installSftpClient(path.join(root, "node_modules"));
    writeFile(path.join(root, "entry.js"), 'export { default } from "sftp-client";');

    await expect(bundleWithEsbuild(root, [])).rejects.toThrow("cpufeatures.node");
    expect(await bundleWithEsbuild(root, [nativeAddonsExternalEsbuild()])).toContain(
      path.join(root, "node_modules/cpu-features/build/Release/cpufeatures.node"),
    );
  });

  it("keeps an addon that was built external", async () => {
    const root = appRoot({ "sftp-client": "*" });
    installSftpClient(path.join(root, "node_modules"));
    writeFile(path.join(root, "node_modules/cpu-features/build/Release/cpufeatures.node"), "\0");
    writeFile(path.join(root, "entry.js"), 'export { default } from "sftp-client";');

    await expect(bundleWithEsbuild(root, [])).rejects.toThrow("cpufeatures.node");
    expect(await bundleWithEsbuild(root, [nativeAddonsExternalEsbuild()])).toContain(
      "cpufeatures.node",
    );
  });

  it("keeps a platform build whose main is the addon external", async () => {
    const root = appRoot({ canvas: "*" });
    installNapiPackage(root);
    installPlatformBuild(root);
    writeFile(path.join(root, "entry.js"), 'export { default } from "canvas";');

    await expect(bundleWithEsbuild(root, [])).rejects.toThrow("skia.linux-x64-gnu.node");
    expect(await bundleWithEsbuild(root, [nativeAddonsExternalEsbuild()])).toContain(
      path.join(root, "node_modules/canvas-linux-x64-gnu/skia.linux-x64-gnu.node"),
    );
  });

  it("leaves a platform build that is not installed to the default resolution", async () => {
    const root = appRoot({ canvas: "*" });
    installNapiPackage(root);
    writeFile(path.join(root, "entry.js"), 'export { default } from "canvas";');

    expect(await bundleWithEsbuild(root, [nativeAddonsExternalEsbuild()])).toBe(
      await bundleWithEsbuild(root, []),
    );
  });

  it("bundles a platform build whose main is a script", async () => {
    const root = appRoot({ "tool-linux-x64": "*" });
    install(root, "tool-linux-x64", { main: "index.js" });
    writeFile(path.join(root, "node_modules/tool-linux-x64/index.js"), "module.exports = 42;");
    writeFile(path.join(root, "entry.js"), 'export { default } from "tool-linux-x64";');

    const code = await bundleWithEsbuild(root, [nativeAddonsExternalEsbuild()]);
    expect(code).toContain("42");
    expect(code).not.toContain('from "');
  });

  it("bundles a script whose name ends in .node, as react-dom/server loads it", async () => {
    const root = appRoot({});
    writeFile(path.join(root, "server.node.js"), "module.exports = { renderToString() {} };");
    writeFile(path.join(root, "entry.js"), 'export { default } from "./server.js";');
    writeFile(path.join(root, "server.js"), 'module.exports = require("./server.node");');

    const code = await bundleWithEsbuild(root, [nativeAddonsExternalEsbuild()]);
    expect(code).toContain("renderToString");
    expect(code).not.toContain('"./server.node"');
  });

  it("still fails on a missing file that is not an addon", async () => {
    const root = appRoot({});
    writeFile(path.join(root, "entry.js"), 'export * from "./missing.js";');
    await expect(bundleWithEsbuild(root, [nativeAddonsExternalEsbuild()])).rejects.toThrow(
      "missing.js",
    );
  });
});

describe("nativeAddonsOptimizerOptions", () => {
  it("sets only the options of the bundler the optimizer runs on", () => {
    expect(nativeAddonsOptimizerOptions(true)).toEqual({
      rolldownOptions: { plugins: [expect.objectContaining({ resolveId: expect.any(Object) })] },
    });
    expect(nativeAddonsOptimizerOptions(false)).toEqual({
      esbuildOptions: { plugins: [expect.objectContaining({ setup: expect.any(Function) })] },
    });
  });

  it("picks Rolldown on Vite 8", () => {
    expect(nativeAddonsOptimizerOptions()).toHaveProperty("rolldownOptions");
  });
});
