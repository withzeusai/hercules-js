import type { Plugin } from "vite";

const VITE_8_DEFAULT_TARGET = ["chrome111", "edge111", "firefox114", "safari16.4", "ios16.4"];

export const BROWSER_BUILD_TARGET = ["chrome111", "edge111", "firefox114", "safari16", "ios16"];

/**
 * Lowers Vite 8's browser build target from Safari and iOS 16.4 to 16, so
 * syntax that 16.0 to 16.3 cannot parse, such as class static blocks, is
 * transformed. CSS keeps Vite's default target. A target the app or another
 * plugin sets is kept, and other Vite majors are left alone.
 */
export function browserTargetPlugin(): Plugin {
  return {
    name: "vite-plugin-hercules-browser-target",
    apply: "build",
    configEnvironment: {
      order: "post",
      handler(name, { build, consumer = name === "client" ? "client" : "server" }) {
        if (
          !this.meta.viteVersion.startsWith("8.") ||
          consumer !== "client" ||
          build?.target != null
        ) {
          return;
        }
        return {
          build: {
            target: BROWSER_BUILD_TARGET,
            ...(build?.cssTarget == null && { cssTarget: VITE_8_DEFAULT_TARGET }),
          },
        };
      },
    },
  };
}
