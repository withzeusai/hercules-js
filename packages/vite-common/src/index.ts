// Code shared by `@usehercules/vite` and `@usehercules/vite-tanstack`. This
// package is never published: both list it as a devDependency, so tsdown
// bundles it into their dist. A TanStack app loads both, so it runs two copies
// of this code. Keep it free of module-level state.

export {
  dependenciesToPrebundle,
  onlyDeclared,
  packageNameOf,
  readDeclaredDependencies,
  sourceEntries,
  withoutExcluded,
  type SourceEntriesOptions,
} from "./dependencies";
export {
  HERCULES_DEV_MACHINE_ENV,
  HERCULES_DEV_SERVER_ENV,
  isHerculesDevMachine,
  isHerculesDevServer,
} from "./environment";
export { importOptional, isModuleNotFound, type ImportOptionalOptions } from "./optional-import";
export { watchDependencies, type WatchDependenciesOptions } from "./restart-on-install";
