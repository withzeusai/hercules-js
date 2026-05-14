---
"@usehercules/vite": patch
---

Fix component-tagger injecting `data-hercules-name` onto JSX from `@react-three/*` companion packages (postprocessing, cannon, rapier, xr), which crashed React Three Fiber's reconciler with `R3F: Cannot set 'data-hercules-name'`. The import-source filter now covers every `@react-three/*` package except `@react-three/fiber`, whose `<Canvas>` renders a real DOM canvas where data attributes are valid.
