import createClient from "openapi-fetch";
import type { paths } from "./types.js";

export type { paths, components, operations } from "./types.js";

export function createAuthClient(
  ...args: Parameters<typeof createClient<paths>>
) {
  return createClient<paths>(...args);
}
export type AuthClient = ReturnType<typeof createAuthClient>;
