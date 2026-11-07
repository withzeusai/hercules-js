import type { Plugin } from "vite";

const INJECT_SOURCE_PLUGIN = "@tanstack/devtools:inject-source";
const IMPORTS_REACT_THREE = /["']@react-three\//;

/**
 * Leaves files that import `@react-three/*` out of devtools' source injection.
 *
 * It adds `data-tsd-source` to every JSX tag, and React Three Fiber reads a
 * dashed prop on its elements (and on drei components that pass props
 * through) as a nested path. When the value changes, as it does after an
 * edit shifts lines, R3F throws `Cannot set "data-tsd-source"` and the canvas
 * crashes. The Hercules component tagger skips these files the same way.
 */
export function skipReactThreeSourceInjection(plugins: Plugin[]): Plugin[] {
  for (const plugin of plugins) {
    const transform = plugin.transform;
    if (plugin.name !== INJECT_SOURCE_PLUGIN || !transform) continue;
    const handler = typeof transform === "function" ? transform : transform.handler;
    const skipping: typeof handler = function (code, ...rest) {
      return IMPORTS_REACT_THREE.test(code) ? undefined : handler.call(this, code, ...rest);
    };
    plugin.transform =
      typeof transform === "function" ? skipping : { ...transform, handler: skipping };
  }
  return plugins;
}
