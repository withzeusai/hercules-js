/**
 * Read by `@usehercules/vite-tanstack` to switch its sandbox-only dev server
 * settings on when set to `"true"`.
 */
export const HERCULES_DEV_SERVER_ENV = "HERCULES_DEV_SERVER";

export function isHerculesDevServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERCULES_DEV_SERVER_ENV] === "true";
}

/**
 * Set to `"1"` by the Hercules dev machine image, so herculesd and the dev
 * server it starts both see it.
 */
export const HERCULES_DEV_MACHINE_ENV = "HERCULES_DEV_MACHINE";

export function isHerculesDevMachine(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERCULES_DEV_MACHINE_ENV] === "1";
}
