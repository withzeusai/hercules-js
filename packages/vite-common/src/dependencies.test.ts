import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dependenciesToPrebundle,
  onlyDeclared,
  packageNameOf,
  sourceEntries,
  withoutExcluded,
} from "./dependencies";
import { appRoot, lib } from "./testing";

const none: ReadonlySet<string> = new Set();

describe("packageNameOf", () => {
  it.each([
    ["clsx", "clsx"],
    ["convex/react", "convex"],
    ["motion/react", "motion"],
    ["@hookform/resolvers/zod", "@hookform/resolvers"],
    ["@tanstack/react-router > @tanstack/react-store", "@tanstack/react-router"],
  ])("maps %s to %s", (entry, name) => {
    expect(packageNameOf(entry)).toBe(name);
  });
});

describe("onlyDeclared", () => {
  it("keeps every entry when package.json cannot be read", () => {
    expect(onlyDeclared(["clsx", "zod"], undefined)).toEqual(["clsx", "zod"]);
  });

  it("drops entries whose package the app does not declare", () => {
    expect(onlyDeclared(["clsx", "convex/react", "zod"], new Set(["convex", "zod"]))).toEqual([
      "convex/react",
      "zod",
    ]);
  });
});

describe("dependenciesToPrebundle", () => {
  it("keeps installed runtime dependencies that load JavaScript", () => {
    const root = appRoot(
      { papaparse: "*", zod: "*", clsx: "*", "lib-noext": "*", "lib-index": "*" },
      {
        papaparse: { main: "papaparse.min.js" },
        zod: { exports: { ".": { types: "./index.d.ts", import: "./index.js" } } },
        clsx: { exports: { import: "./dist/clsx.mjs", default: "./dist/clsx.js" } },
        "lib-noext": { main: "lib/index" },
        "lib-index": {},
      },
    );
    writeFileSync(path.join(root, "node_modules/lib-index/index.js"), "");
    expect(dependenciesToPrebundle(root, none)).toEqual([
      "clsx",
      "lib-index",
      "lib-noext",
      "papaparse",
      "zod",
    ]);
  });

  it("leaves out packages the optimizer cannot bundle", () => {
    const root = appRoot(
      {
        "@types/papaparse": "*",
        "@fontsource-variable/geist": "*",
        "subpaths-only": "*",
        "native-gyp": "*",
        "native-loader": "*",
        sharp: "*",
        "not-installed": "*",
      },
      {
        "@types/papaparse": { types: "index.d.ts" },
        "@fontsource-variable/geist": { main: "index.css", exports: { ".": "./index.css" } },
        "subpaths-only": { exports: { "./client": "./client.js" } },
        "native-gyp": { main: "index.js", gypfile: true },
        "native-loader": { main: "index.js", dependencies: { "node-gyp-build": "*" } },
        sharp: { main: "lib/index.js", optionalDependencies: { "@img/sharp-linux-x64": "*" } },
      },
    );
    expect(dependenciesToPrebundle(root, none)).toEqual([]);
  });

  it("leaves out the names the caller never bundles", () => {
    const root = appRoot({ react: "*", zod: "*" }, { react: lib, zod: lib });
    expect(dependenciesToPrebundle(root, new Set(["react"]))).toEqual(["zod"]);
  });

  it("leaves out a package a project-root file shadows", () => {
    const root = appRoot({ convex: "*", zod: "*" }, { convex: lib, zod: lib });
    writeFileSync(path.join(root, "convex.json"), "{}");
    expect(dependenciesToPrebundle(root, none)).toEqual(["zod"]);
  });

  it("ignores devDependencies", () => {
    const root = appRoot({}, { vitest: lib });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: {}, devDependencies: { vitest: "*" } }),
    );
    expect(dependenciesToPrebundle(root, none)).toEqual([]);
  });

  it("returns nothing when package.json cannot be read", () => {
    expect(dependenciesToPrebundle(path.join(tmpdir(), "does-not-exist"), none)).toEqual([]);
  });
});

describe("withoutExcluded", () => {
  it("drops entries excluded by entry or by package", () => {
    expect(
      withoutExcluded(["clsx", "convex/react", "zod", "lodash/debounce"], ["convex", "zod"]),
    ).toEqual(["clsx", "lodash/debounce"]);
  });

  it("keeps every entry when nothing is excluded", () => {
    expect(withoutExcluded(["clsx"], undefined)).toEqual(["clsx"]);
  });
});

describe("sourceEntries", () => {
  it("scans the source tree without tests or type declarations", () => {
    expect(sourceEntries("app/")).toEqual([
      "app/**/*.{js,jsx,ts,tsx,mjs,mts}",
      "!app/**/*.d.{ts,mts}",
      "!app/**/*.{test,spec,stories}.{js,jsx,ts,tsx,mjs,mts}",
      "!app/**/__tests__/**",
      "!app/**/__mocks__/**",
    ]);
  });

  it("leaves out server modules on request", () => {
    expect(sourceEntries("src", { serverFiles: false })).toEqual([
      ...sourceEntries("src"),
      "!src/**/*.server.{js,jsx,ts,tsx,mjs,mts}",
      "!src/server/**",
    ]);
  });
});
