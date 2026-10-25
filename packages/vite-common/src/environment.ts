/**
 * Set to `"true"` by the Hercules dev machine. It is the same signal
 * `@usehercules/vite` already reads, so one variable switches every
 * sandbox-only behaviour on.
 */
export const HERCULES_DEV_SERVER_ENV = "HERCULES_DEV_SERVER";

export function isHerculesDevServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[HERCULES_DEV_SERVER_ENV] === "true";
}
