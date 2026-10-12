// __LIB_VERSION__ is replaced at build time (see tsdown.config.ts) with the
// package.json version, so published events report the exact client version.
declare const __LIB_VERSION__: string;

export const LIB_VERSION: string =
  typeof __LIB_VERSION__ !== "undefined" ? __LIB_VERSION__ : "unknown";
