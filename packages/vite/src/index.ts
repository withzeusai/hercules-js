import type { Plugin } from "vite";
import { componentTaggerPlugin, type ComponentTaggerOptions } from "./component-tagger";
import { optimizerEntriesPlugin, prebundleDependenciesPlugin } from "./prebundle";
import { visualEditorPlugin, type VisualEditorOptions } from "./visual-editor";

export interface HerculesPluginOptions {
  /**
   * Component tagger options
   *
   * Tagging attributes (`data-hercules-id` / `data-hercules-name`) are injected
   * on the dev server only; `vite build` output never contains them.
   *
   * @default { enabled: true }
   */
  componentTagger?: ComponentTaggerOptions & { enabled?: boolean };

  /**
   * Visual editor options. Serves the endpoints the visual editor calls to
   * change the source of a tagged element (dev server only).
   * @default { enabled: true }
   */
  visualEditor?: VisualEditorOptions & { enabled?: boolean };

  /**
   * Bundle every runtime dependency in the app's `package.json` up front on
   * the dev server, so Vite does not discover one mid-session and reload the
   * page. On the Hercules dev machine the dev server also restarts when
   * `package.json` or the lockfile changes, so a package the agent installs is
   * bundled before code imports it. `@usehercules/vite-tanstack` turns this
   * off and bundles the dependencies of both its environments itself.
   * @default true
   */
  prebundleDependencies?: boolean;
}

/**
 * Hercules Vite plugin: tags JSX elements for the visual editor and keeps the
 * dependency optimizer from re-bundling mid-session. All of it runs on the dev
 * server only.
 */
export function hercules(options: HerculesPluginOptions = {}): Plugin[] {
  const {
    componentTagger = { enabled: true },
    visualEditor = { enabled: true },
    prebundleDependencies = true,
  } = options;

  const plugins: Plugin[] = [];

  if (componentTagger.enabled) {
    plugins.push(
      componentTaggerPlugin({
        dataAttribute: visualEditor.enabled ? "data-hercules-id" : "data-component-id",
        ...componentTagger,
      }),
    );
  }

  if (visualEditor.enabled) {
    plugins.push(visualEditorPlugin(visualEditor));
  }

  plugins.push(optimizerEntriesPlugin());
  if (prebundleDependencies) plugins.push(prebundleDependenciesPlugin());

  return plugins;
}

// Default export for convenience
export default hercules;
