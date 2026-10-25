---
"@usehercules/vite": major
---

Slim the plugin down to what has to run inside the app's Vite process: the component tagger, the visual editor's endpoints, and dependency pre-bundling. herculesd already serves and injects the error handler and visual editor scripts, and handles `vite:error` in the browser, so the copies here are gone.

Removed options (delete them from your `hercules()` call if you passed them):

- `handleViteErrors`: the server-side `[Vite Error]` and `[Vite Server Error]` logging, the `/__hercules_error_handler.js` route and its `<script>` tag are gone.
- `debug`: set `componentTagger.debug` or `visualEditor.debug` instead.
- `message`: it was only logged at build start.
- `visualEditor.dataAttribute`: it only configured the visual editor script, which this plugin no longer serves.

Also removed: the `/__hercules_visual_editor.js` route and its `<script>` tag, the `/hercules-status` and `/hercules-component-tagger-stats` endpoints, and the plugin's empty `load`, `transform`, `resolveId`, `handleHotUpdate` and `generateBundle` hooks. The package's exports (`hercules`, the default export, and `HerculesPluginOptions`) are unchanged. The visual editor's `/__hercules_analyze_element`, `/__hercules_update_element` and `/__hercules_delete_element` endpoints stay until herculesd serves them.

Dependency pre-bundling now covers what the agent installs. On the dev server every runtime dependency in `package.json` is bundled up front (skipping React, CSS-only and types-only packages, native addons, and anything in `optimizeDeps.exclude`), on top of the existing crawl of `src`. On the Hercules dev machine (`HERCULES_DEV_MACHINE=1`) the dev server restarts when `package.json` or the lockfile changes and the bundled set differs, so a new package is bundled before code imports it instead of making Vite re-optimize and reload the page. A local `vite dev` does not restart. Set `prebundleDependencies: false` to turn both off.

On Vite 8 the component tagger parses with Vite's own parser instead of Babel. `data-hercules-id` values are unchanged; files Babel could not parse, such as ones with decorators, are now tagged too. Vite 7 still uses Babel.

The package no longer publishes its `src` directory.
