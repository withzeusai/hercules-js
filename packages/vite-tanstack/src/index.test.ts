import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Alias, ConfigEnv, Plugin, PluginOption } from "vite";
import {
  DEDUPE,
  HERCULES_DEV_MACHINE_ENV,
  HERCULES_DEV_SERVER_ENV,
  HERCULES_STARTUP_PROFILE_ENV,
  TOOL_MANAGED_WATCH_IGNORES,
  defineConfig,
  herculesBaseConfig,
} from "./index";

const devtools = vi.hoisted(() => vi.fn((_options?: unknown) => ({ name: "devtools-stub" })));
vi.mock("@tanstack/devtools-vite", () => ({ devtools }));

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

/** Whether the startup profile plugin reports, rather than only holding its place. */
function isProfiling(plugins: PluginOption[] | undefined): boolean {
  const first = plugins?.[0] as Plugin | undefined;
  expect(first?.name).toBe("hercules:startup-profile");
  return first?.configureServer !== undefined;
}

/** The rolldown plugins the startup profile's plugin adds to the optimizer of an environment. */
function optimizerPluginNames(plugins: PluginOption[] | undefined): string[] {
  const configEnvironment = (plugins?.[0] as Plugin).configEnvironment as unknown as (
    name: string,
  ) => { optimizeDeps: { rolldownOptions: { plugins: Array<{ name: string }> } } };
  return configEnvironment("client").optimizeDeps.rolldownOptions.plugins.map((p) => p.name);
}

function aliasEntries(alias: unknown): Alias[] {
  return alias as Alias[];
}

afterEach(() => {
  vi.unstubAllEnvs();
  devtools.mockClear();
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

  it("also resolves the paths in tsconfig.json", () => {
    const config = herculesBaseConfig({}, { sandbox: false });
    expect(config.resolve?.tsconfigPaths).toBe(true);
  });

  it("dedupes React and TanStack", () => {
    const config = herculesBaseConfig({}, { sandbox: false });
    expect(config.resolve?.dedupe).toEqual(DEDUPE);
  });

  it("leaves dependency pre-bundling to the plugin", () => {
    const config = herculesBaseConfig({}, { sandbox: false });
    expect(config.optimizeDeps).toBeUndefined();
    expect(config.environments).toBeUndefined();
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

  it("turns the sandbox settings on on a Hercules dev machine", () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, "1");
    vi.stubEnv(HERCULES_DEV_SERVER_ENV, undefined);
    expect(herculesBaseConfig({}).server?.strictPort).toBe(true);
  });

  it("still takes HERCULES_DEV_SERVER=true as the sandbox flag", () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, undefined);
    vi.stubEnv(HERCULES_DEV_SERVER_ENV, "true");
    expect(herculesBaseConfig({}).server?.strictPort).toBe(true);
  });

  it("leaves the sandbox settings off when neither variable is set", () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, undefined);
    vi.stubEnv(HERCULES_DEV_SERVER_ENV, undefined);
    const { server } = herculesBaseConfig({});
    expect(server?.strictPort).toBeUndefined();
    expect(server?.watch).toBeUndefined();
  });
});

describe("defineConfig", () => {
  it("returns a config function that assembles the plugin stack", async () => {
    const config = await defineConfig(bare)(serve);
    const names = pluginNames(config.plugins);
    expect(names.some((n) => n.includes("tanstack"))).toBe(true);
    expect(names.some((n) => n.startsWith("vite:react"))).toBe(true);
  });

  it("holds page requests during reloads unless turned off", async () => {
    // Second, after the startup profile's plugin.
    const on = pluginNames((await defineConfig(bare)(serve)).plugins);
    expect(on[1]).toBe("hercules:hold-pages-during-reload");

    const off = pluginNames(
      (await defineConfig({ ...bare, holdPagesDuringReload: false })(serve)).plugins,
    );
    expect(off).not.toContain("hercules:hold-pages-during-reload");
  });

  it("pre-bundles dependencies, with the extra entries passed through", async () => {
    const config = await defineConfig({ ...bare, prebundle: ["lodash/debounce"] })(serve);
    const plugin = (config.plugins as Plugin[]).find(
      (p) => p.name === "hercules:prebundle-dependencies",
    );
    expect(plugin).toBeDefined();
    const configEnvironment = plugin!.configEnvironment as unknown as (
      name: string,
      config: object,
    ) => { optimizeDeps?: { include?: string[] } } | undefined;
    expect(configEnvironment("client", {})?.optimizeDeps?.include).toContain("lodash/debounce");
  });

  it("keeps @usehercules/vite's own dependency pre-bundling off", async () => {
    const names = pluginNames((await defineConfig({ ...bare, hercules: {} })(serve)).plugins);
    expect(names).toContain("vite-plugin-hercules-component-tagger");
    expect(names).toContain("hercules:prebundle-dependencies");
    expect(names).not.toContain("vite-plugin-hercules-prebundle-dependencies");
  });

  it("turns devtools console piping off unless the app sets it", async () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, undefined);
    await defineConfig({ ...bare, devtools: undefined })(serve);
    expect(devtools).toHaveBeenLastCalledWith({
      consolePiping: { enabled: false },
      enhancedLogs: { enabled: false },
    });

    await defineConfig({ ...bare, devtools: { consolePiping: { enabled: true } } })(serve);
    expect(devtools).toHaveBeenLastCalledWith({
      consolePiping: { enabled: true },
      enhancedLogs: { enabled: false },
    });
  });

  it("leaves devtools out of the dev server on a Hercules dev machine unless the app sets it", async () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, "1");
    const dev = await defineConfig({ ...bare, devtools: undefined })(serve);
    expect(devtools).not.toHaveBeenCalled();
    expect(pluginNames(dev.plugins)).not.toContain("devtools-stub");

    await defineConfig({ ...bare, devtools: undefined })({ command: "build", mode: "production" });
    expect(devtools).toHaveBeenCalledOnce();

    await defineConfig({ ...bare, devtools: { consolePiping: { enabled: true } } })(serve);
    expect(devtools).toHaveBeenCalledTimes(2);
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
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, "1");
    const config = await defineConfig({
      ...bare,
      vite: { server: { watch: { ignored: ["**/generated/**"] } } },
    })(serve);
    const ignored = config.server?.watch?.ignored as string[];
    expect(ignored).toEqual([...TOOL_MANAGED_WATCH_IGNORES, "**/generated/**"]);
  });

  it("profiles the dev server start on a Hercules dev machine, user plugins included", async () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, "1");
    vi.stubEnv(HERCULES_STARTUP_PROFILE_ENV, undefined);
    const config = await defineConfig({ ...bare, plugins: [{ name: "user-plugin" }] })(serve);
    const names = pluginNames(config.plugins);
    expect(names[0]).toBe("hercules:startup-profile");
    expect(names).toContain("user-plugin");
    expect(isProfiling(config.plugins)).toBe(true);
  });

  it("keeps the plugin names the same when profiling is off, so Vite's cache survives", async () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, "1");
    vi.stubEnv(HERCULES_STARTUP_PROFILE_ENV, undefined);
    const on = await defineConfig(bare)(serve);
    const off = await defineConfig({ ...bare, startupProfile: false })(serve);
    expect(isProfiling(off.plugins)).toBe(false);
    expect(pluginNames(off.plugins)).toEqual(pluginNames(on.plugins));
    // The optimizer's own plugin names are in the cache hash too.
    expect(optimizerPluginNames(off.plugins)).toEqual(["hercules:startup-profile-optimizer"]);
    expect(optimizerPluginNames(off.plugins)).toEqual(optimizerPluginNames(on.plugins));
  });

  it("leaves the profile plugin out of builds", async () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, "1");
    const build = await defineConfig(bare)({ command: "build", mode: "production" });
    expect(pluginNames(build.plugins)).not.toContain("hercules:startup-profile");
  });

  it("profiles off the dev machine only when asked", async () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, undefined);
    vi.stubEnv(HERCULES_STARTUP_PROFILE_ENV, undefined);
    expect(isProfiling((await defineConfig(bare)(serve)).plugins)).toBe(false);
    const asked = await defineConfig({ ...bare, startupProfile: true })(serve);
    expect(isProfiling(asked.plugins)).toBe(true);
  });

  it("lets HERCULES_STARTUP_PROFILE switch profiling for one machine, over the option", async () => {
    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, "1");
    vi.stubEnv(HERCULES_STARTUP_PROFILE_ENV, "0");
    expect(isProfiling((await defineConfig(bare)(serve)).plugins)).toBe(false);
    const asked = await defineConfig({ ...bare, startupProfile: true })(serve);
    expect(isProfiling(asked.plugins)).toBe(false);

    vi.stubEnv(HERCULES_DEV_MACHINE_ENV, undefined);
    vi.stubEnv(HERCULES_STARTUP_PROFILE_ENV, "1");
    expect(isProfiling((await defineConfig(bare)(serve)).plugins)).toBe(true);
  });
});
