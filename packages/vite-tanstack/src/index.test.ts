import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Alias, ConfigEnv, Plugin, PluginOption } from "vite";
import {
  DEDUPE,
  HERCULES_DEV_SERVER_ENV,
  TOOL_MANAGED_WATCH_IGNORES,
  defineConfig,
  herculesBaseConfig,
  isHerculesDevServer,
} from "./index";

const serve: ConfigEnv = { command: "serve", mode: "development" };

// Only TanStack Start and plugin-react are always loaded; everything optional
// is switched off so the tests exercise config assembly, not the plugins.
const bare = { devtools: false, tailwind: false, hercules: false, cloudflare: false } as const;

function pluginNames(plugins: PluginOption[] | undefined): string[] {
  const names: string[] = [];
  const visit = (p: PluginOption): void => {
    if (!p) return;
    if (Array.isArray(p)) {
      p.forEach(visit);
      return;
    }
    if (p instanceof Promise) return;
    names.push((p as Plugin).name);
  };
  plugins?.forEach(visit);
  return names;
}

function aliasEntries(alias: unknown): Alias[] {
  return alias as Alias[];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isHerculesDevServer", () => {
  it("is on only when the env var is exactly 'true'", () => {
    expect(isHerculesDevServer({})).toBe(false);
    expect(isHerculesDevServer({ [HERCULES_DEV_SERVER_ENV]: "1" })).toBe(false);
    expect(isHerculesDevServer({ [HERCULES_DEV_SERVER_ENV]: "true" })).toBe(true);
  });
});

describe("herculesBaseConfig", () => {
  it("maps @/convex before @ so the convex alias is not shadowed", () => {
    const config = herculesBaseConfig({ vite: { root: "/app" } }, { sandbox: false });
    const alias = aliasEntries(config.resolve?.alias);
    expect(alias.map((a) => a.find)).toEqual(["@/convex", "@"]);
    expect(alias[0]?.replacement).toBe(path.resolve("/app/convex"));
    expect(alias[1]?.replacement).toBe(path.resolve("/app/src"));
  });

  it("honours srcDir and drops the convex alias when convexDir is false", () => {
    const config = herculesBaseConfig(
      { vite: { root: "/app" }, srcDir: "app", convexDir: false },
      { sandbox: false },
    );
    const alias = aliasEntries(config.resolve?.alias);
    expect(alias.map((a) => a.find)).toEqual(["@"]);
    expect(alias[0]?.replacement).toBe(path.resolve("/app/app"));
  });

  it("dedupes React and TanStack", () => {
    const config = herculesBaseConfig({}, { sandbox: false });
    expect(config.resolve?.dedupe).toEqual(DEDUPE);
  });

  it("uses the Hercules dev-server shape everywhere", () => {
    const config = herculesBaseConfig({}, { sandbox: false });
    expect(config.server).toMatchObject({
      host: "0.0.0.0",
      port: 5173,
      allowedHosts: true,
      hmr: { overlay: false },
    });
    expect(config.server?.strictPort).toBeUndefined();
    expect(config.server?.watch).toBeUndefined();
  });

  it("pins the port and ignores tool-managed dirs inside the sandbox", () => {
    const config = herculesBaseConfig({}, { sandbox: true });
    expect(config.server?.strictPort).toBe(true);
    expect(config.server?.watch?.ignored).toEqual(TOOL_MANAGED_WATCH_IGNORES);
    expect(config.server?.watch?.awaitWriteFinish).toEqual({
      stabilityThreshold: 1000,
      pollInterval: 100,
    });
  });

  it("reads the sandbox flag from the environment by default", () => {
    vi.stubEnv(HERCULES_DEV_SERVER_ENV, "true");
    expect(herculesBaseConfig({}).server?.strictPort).toBe(true);
  });
});

describe("defineConfig", () => {
  it("returns a config function that assembles the plugin stack", async () => {
    const config = await defineConfig(bare)(serve);
    const names = pluginNames(config.plugins);
    expect(names.some((n) => n.includes("tanstack"))).toBe(true);
    expect(names.some((n) => n.startsWith("vite:react"))).toBe(true);
  });

  it("appends user plugins after the Hercules stack", async () => {
    const mine: Plugin = { name: "mine" };
    const config = await defineConfig({ ...bare, plugins: [mine] })(serve);
    const names = pluginNames(config.plugins);
    expect(names.at(-1)).toBe("mine");
  });

  it("treats a plain Vite config as an override of the defaults", async () => {
    const config = await defineConfig({
      ...bare,
      vite: { server: { port: 4000 }, build: { sourcemap: true } },
    })(serve);
    expect(config.server?.port).toBe(4000);
    expect(config.server?.host).toBe("0.0.0.0");
    expect(config.build).toMatchObject({ sourcemap: true, chunkSizeWarningLimit: 1000 });
  });

  it("accepts a config function like Vite's defineConfig", async () => {
    const seen: ConfigEnv[] = [];
    // Plugins are not disabled here on purpose: a bare Vite config must still
    // get the full stack, so we only check the env is forwarded.
    const fn = defineConfig((env) => {
      seen.push(env);
      return { ...{ server: { port: 4321 } } };
    });
    await expect(fn(serve)).resolves.toMatchObject({ server: { port: 4321 } });
    expect(seen).toEqual([serve]);
  }, 60_000);

  it("keeps user aliases ahead of the defaults", async () => {
    const config = await defineConfig({
      ...bare,
      vite: { resolve: { alias: { "~": "/elsewhere" } } },
    })(serve);
    const alias = aliasEntries(config.resolve?.alias);
    expect(alias[0]?.find).toBe("~");
    expect(alias.map((a) => a.find)).toContain("@/convex");
  });

  it("merges watch ignores from the user with the sandbox defaults", async () => {
    vi.stubEnv(HERCULES_DEV_SERVER_ENV, "true");
    const config = await defineConfig({
      ...bare,
      vite: { server: { watch: { ignored: ["**/generated/**"] } } },
    })(serve);
    const ignored = config.server?.watch?.ignored as string[];
    expect(ignored).toEqual([...TOOL_MANAGED_WATCH_IGNORES, "**/generated/**"]);
  });
});
