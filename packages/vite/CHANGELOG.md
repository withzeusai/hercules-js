# @usehercules/vite

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
