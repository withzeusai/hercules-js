# @usehercules/vite

## 2.0.1

### Patch Changes

- [#197](https://github.com/withzeusai/hercules-js/pull/197) [`6a8b36e`](https://github.com/withzeusai/hercules-js/commit/6a8b36ef32f8a9ba3063d2f77fc5eea9be5f3d10) Thanks [@delbyte](https://github.com/delbyte)! - Stop tagging components imported from `@vis.gl/react-google-maps`. `<Pin>` passes every prop to the Google Maps `PinElement` constructor, which threw `Unknown property 'data-hercules-id' of PinElement` and blanked the page in the dev preview. Those components never put the attributes in the DOM, so the visual editor loses nothing.

## 2.0.0

### Major Changes

- [#189](https://github.com/withzeusai/hercules-js/pull/189) [`0c1da2b`](https://github.com/withzeusai/hercules-js/commit/0c1da2ba38fdf594cff1cb34d9dc535ec2c1ade2) Thanks [@grant0417](https://github.com/grant0417)! - Remove the dynamic component creator. On a Hercules dev machine it wrote a stub file for any imported component that did not exist, which hid a broken import that lint and the build would otherwise report. The `dynamicComponentCreator` option and the `dynamicComponentCreatorPlugin` export are gone; delete the option from your `hercules()` call if you passed it.

- [#192](https://github.com/withzeusai/hercules-js/pull/192) [`5128d5d`](https://github.com/withzeusai/hercules-js/commit/5128d5d93275d5589404a738ef8e61ea86273ac6) Thanks [@grant0417](https://github.com/grant0417)! - Slim the plugin down to what has to run inside the app's Vite process: the component tagger, the visual editor's endpoints, and dependency pre-bundling. herculesd already serves and injects the error handler and visual editor scripts, and handles `vite:error` in the browser, so the copies here are gone.

  Removed options (delete them from your `hercules()` call if you passed them):

  - `handleViteErrors`: the server-side `[Vite Error]` and `[Vite Server Error]` logging, the `/__hercules_error_handler.js` route and its `<script>` tag are gone.
  - `debug`: set `componentTagger.debug` or `visualEditor.debug` instead.
  - `message`: it was only logged at build start.
  - `visualEditor.dataAttribute`: it only configured the visual editor script, which this plugin no longer serves.

  Also removed: the `/__hercules_visual_editor.js` route and its `<script>` tag, the `/hercules-status` and `/hercules-component-tagger-stats` endpoints, and the plugin's empty `load`, `transform`, `resolveId`, `handleHotUpdate` and `generateBundle` hooks. The package's exports (`hercules`, the default export, and `HerculesPluginOptions`) are unchanged. The visual editor's `/__hercules_analyze_element`, `/__hercules_update_element` and `/__hercules_delete_element` endpoints stay until herculesd serves them.

  Dependency pre-bundling now covers what the agent installs. On the dev server every runtime dependency in `package.json` is bundled up front (skipping React, CSS-only and types-only packages, native addons, and anything in `optimizeDeps.exclude`), on top of the existing crawl of `src`. On the Hercules dev machine (`HERCULES_DEV_MACHINE=1`) the dev server restarts when `package.json` or the lockfile changes and the bundled set differs, so a new package is bundled before code imports it instead of making Vite re-optimize and reload the page. A local `vite dev` does not restart. Set `prebundleDependencies: false` to turn both off.

  On Vite 8 the component tagger parses with Vite's own parser instead of Babel. `data-hercules-id` values are unchanged; files Babel could not parse, such as ones with decorators, are now tagged too. Vite 7 still uses Babel.

  The package no longer publishes its `src` directory.

### Patch Changes

- [#187](https://github.com/withzeusai/hercules-js/pull/187) [`c277313`](https://github.com/withzeusai/hercules-js/commit/c2773132579db4287f266ebde345a8f7b11c02a5) Thanks [@grant0417](https://github.com/grant0417)! - Update `magic-string` to 1.x. It ships ESM only, so the component tagger now imports `MagicString` by name; the default import resolved to the module namespace in the CJS build and every file failed to tag.

- [#193](https://github.com/withzeusai/hercules-js/pull/193) [`f76f96e`](https://github.com/withzeusai/hercules-js/commit/f76f96ec6e9d68f4f9043b4cb56ed68f50a08977) Thanks [@grant0417](https://github.com/grant0417)! - Turn the dev machine settings (`strictPort`, the watch ignores for agent-managed directories, and `awaitWriteFinish`) on when `HERCULES_DEV_MACHINE=1`, which the Hercules dev machine image sets and herculesd passes on to the dev server. They were gated on `HERCULES_DEV_SERVER=true` alone, which nothing on the platform sets, so they never turned on. `HERCULES_DEV_SERVER=true` still works as an alternate trigger.

  Pre-bundle every Base UI component entry when the app declares `@base-ui/react`: each one (`@base-ui/react/dialog`, ...) is its own optimizer entry, read from the package's export map minus `./internals/*`, so the first component the app imports no longer triggers a re-bundle and a full reload. `@shadcn/react/message-scroller` joins `PREBUNDLED_ENTRIES`.

  Turn on `resolve.tsconfigPaths` in the Vite and Vitest configs, next to the `@` and `@/convex` aliases, so any other `paths` the app adds to `tsconfig.json` resolve as well (Vite 8).

  Dependency pre-bundling in both `@usehercules/vite` and `@usehercules/vite-tanstack` now skips CSS-only fontsource packages (`@fontsource-variable/geist` and the like). Their export map lists an `index.d.css.ts` declaration, which was taken for a JavaScript entry, so Vite was asked to bundle a stylesheet.

## 1.2.5

### Patch Changes

- [#179](https://github.com/withzeusai/hercules-js/pull/179) [`3266cf4`](https://github.com/withzeusai/hercules-js/commit/3266cf42ff3ff6fa0776792fbc8d6c32c8b6a77b) Thanks [@delbyte](https://github.com/delbyte)! - Tag JSX elements after their type arguments. An element with explicit type arguments, such as `<Select<Option> value={value} />`, got its `data-hercules-id` and `data-hercules-name` attributes between the tag name and the type arguments, which is a syntax error, so the dev preview failed to load.

- [#175](https://github.com/withzeusai/hercules-js/pull/175) [`37506e2`](https://github.com/withzeusai/hercules-js/commit/37506e20bfeee55651a3df389f1c91f9bfd450da) Thanks [@delbyte](https://github.com/delbyte)! - Stop tagging components in files that import from `@react-three/*`, except those imported from `@react-three/fiber` such as `<Canvas>`. A wrapper like `function Tag(props) { return <Html {...props} /> }` forwarded `data-hercules-name` into the React Three Fiber reconciler, which threw `R3F: Cannot set "data-hercules-name"` and blanked the canvas in the dev preview. DOM elements in those files are still tagged.

## 1.2.4

### Patch Changes

- [#176](https://github.com/withzeusai/hercules-js/pull/176) [`2455a9c`](https://github.com/withzeusai/hercules-js/commit/2455a9cb150cf4c7bc3d4e8cdae3fbec5fd7843c) Thanks [@adrian-hercules](https://github.com/adrian-hercules)! - Take element ids' line and column from the file on disk when an earlier plugin changed the code. TanStack devtools (listed before `hercules()` in the TanStack Start template) adds a `data-tsd-source` attribute to every opening tag, so each element after the first on a line got a column too far right, and the visual editor failed with "Component not found" when it saved a text or class change to that element.

## 1.2.3

### Patch Changes

- [#173](https://github.com/withzeusai/hercules-js/pull/173) [`f27ab75`](https://github.com/withzeusai/hercules-js/commit/f27ab755a8367888a332f769f1210b2fcd8d921d) Thanks [@adrian-hercules](https://github.com/adrian-hercules)! - Tag TanStack route split modules when they load, from the route file on disk. With `tanstackStart()` or `tanstackRouter()` listed before `hercules()`, the tagger received the router plugin's regenerated code, so its `data-hercules-id` line and column did not match the route file and the visual editor could change the wrong element.

## 1.2.2

### Patch Changes

- [#171](https://github.com/withzeusai/hercules-js/pull/171) [`c807772`](https://github.com/withzeusai/hercules-js/commit/c8077720e8c034aa9eca807fbf78ceedca6bab73) Thanks [@adrian-hercules](https://github.com/adrian-hercules)! - Tag JSX in TanStack Router route components. The code splitter loads them from `?tsr-split` and `?tsr-shared` virtual modules, which the component tagger skipped, so the visual editor could not select anything on a TanStack Start page.

## 1.2.1

### Patch Changes

- [#133](https://github.com/withzeusai/hercules-js/pull/133) [`8abc7b1`](https://github.com/withzeusai/hercules-js/commit/8abc7b1ed2bb03cca46c6084a3205dcaa8c1ef02) Thanks [@delbyte](https://github.com/delbyte)! - Seed the Vite dependency optimizer from every source file at dev-server startup so large apps with many lazy-loaded routes no longer trigger a mid-session re-optimize and full reload. The reload could leave react-dom bound to a previous optimizer generation of React, producing the recurring "Cannot read properties of null (reading 'useContext'/'useMemo')" crash. Only `src` is crawled, so server-only dependencies are never pre-bundled.

## 1.2.0

### Minor Changes

- [#120](https://github.com/withzeusai/hercules-js/pull/120) [`8fb36ce`](https://github.com/withzeusai/hercules-js/commit/8fb36ce902d6af7bfd94cce5471c4c2d9343a61b) Thanks [@grant0417](https://github.com/grant0417)! - Keep component tagging out of production builds

  The component tagger and visual editor plugins are now `apply: "serve"`, so
  they never run during `vite build`. Built output contains no `data-hercules-id`
  / `data-hercules-name` attributes and no injected editor script, giving
  published sites white-label markup. Previously the tagger ran in builds
  unconditionally, and the editor's script tag could leak into built HTML when
  `NODE_ENV` was unset during the build.

## 1.1.0

### Minor Changes

- [#80](https://github.com/withzeusai/hercules-js/pull/80) [`6acfa12`](https://github.com/withzeusai/hercules-js/commit/6acfa1291399848ca544b2f69a7922cebdbca23e) Thanks [@grant0417](https://github.com/grant0417)! - Add support for Vite 8. The `vite` peer dependency range is now `^7.0.0 || ^8.0.0`.

## 1.0.42

### Patch Changes

- [#41](https://github.com/withzeusai/hercules-js/pull/41) [`2aed44b`](https://github.com/withzeusai/hercules-js/commit/2aed44b24fd0a6df4e72f57f0eaeb3e678a3d1d5) Thanks [@delbyte](https://github.com/delbyte)! - Fix component-tagger injecting `data-hercules-name` onto JSX from `@react-three/*` companion packages (postprocessing, cannon, rapier, xr), which crashed React Three Fiber's reconciler with `R3F: Cannot set 'data-hercules-name'`. The import-source filter now covers every `@react-three/*` package except `@react-three/fiber`, whose `<Canvas>` renders a real DOM canvas where data attributes are valid.

## 1.0.41

### Patch Changes

- [#14](https://github.com/withzeusai/hercules-js/pull/14) [`5efd2ba`](https://github.com/withzeusai/hercules-js/commit/5efd2bacb54710376c585f4362c0e7988e8bf7fb) Thanks [@grant0417](https://github.com/grant0417)! - Add changesets for package versioning and publishing
