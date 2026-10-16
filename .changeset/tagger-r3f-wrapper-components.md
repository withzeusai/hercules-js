---
"@usehercules/vite": patch
---

Stop tagging components in files that import from `@react-three/*`, except those imported from `@react-three/fiber` such as `<Canvas>`. A wrapper like `function Tag(props) { return <Html {...props} /> }` forwarded `data-hercules-name` into the React Three Fiber reconciler, which threw `R3F: Cannot set "data-hercules-name"` and blanked the canvas in the dev preview. DOM elements in those files are still tagged.
