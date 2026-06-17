// Ambient types for the test environment only. Referenced exclusively by
// tsconfig.tests.json (the production build tsconfig only includes `src/**/*`,
// so this augmentation never reaches shipped code). The convex-test suites load
// component modules via Vite's `import.meta.glob`; `vite/client` is a transitive
// dep of vitest and is not directly resolvable from this package, so declare the
// glob signature here. The precise return type (a record of lazy module loaders)
// lets convex-test infer the schema DataModel for the `t.run` ctx.
interface ImportMeta {
  glob: (
    patterns: string | string[],
    options?: Record<string, unknown>,
  ) => Record<string, () => Promise<Record<string, unknown>>>;
}
