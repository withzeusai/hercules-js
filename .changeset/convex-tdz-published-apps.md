---
"@usehercules/vite": patch
---

Prevent a "Cannot access 'X' before initialization" crash in published apps. The plugin now isolates the Convex client into its own production chunk, so its module-scoped bindings (the react hooks, value codecs, and the `anyApi` proxy behind `_generated/api`) initialize once, before the lazily-loaded route chunks that import them. Left to Rollup's default splitting, those bindings could be hoisted into a shared chunk that formed a circular reference with a route chunk; in the minified production build the reference was read before initialization, so the published app threw during a lazy route load and rendered its error boundary. The dev server serves native ESM without chunking, so the crash only ever appeared in the published bundle. The grouping applies to the client build only (SSR builds are skipped), and `optimizeDeps.include` is added for convex only when the app depends on it, so apps without Convex are unaffected.
