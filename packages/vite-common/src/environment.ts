/**
 * Set to `"true"` to switch on `@usehercules/vite-tanstack`'s dev machine
 * settings where `HERCULES_DEV_MACHINE` is not set. Nothing on the Hercules
 * platform sets it.
 */
export const HERCULES_DEV_SERVER_ENV = "HERCULES_DEV_SERVER";

export function isHerculesDevServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERCULES_DEV_SERVER_ENV] === "true";
}

/**
 * Set to `"1"` by the Hercules dev machine image, so herculesd and the dev
 * server it starts both see it. `@usehercules/vite` restarts on dependency
 * changes and `@usehercules/vite-tanstack` turns on its dev machine settings
 * when it is set.
 */
export const HERCULES_DEV_MACHINE_ENV = "HERCULES_DEV_MACHINE";

export function isHerculesDevMachine(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERCULES_DEV_MACHINE_ENV] === "1";
}
