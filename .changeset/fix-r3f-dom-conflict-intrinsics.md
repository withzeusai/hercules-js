---
"@usehercules/vite": patch
---

Stop tagging R3F intrinsics whose names collide with DOM elements (`<line>`,
`<path>`, `<audio>`, `<source>`, `<clippingGroup>`).

The component tagger skipped tagging on R3F intrinsics like `<mesh>` and
`<lineSegments>` whose lowercased names do not clash with any DOM element, but
kept tagging `<line>` because `line` is also a real SVG element. Inside an R3F
`<Canvas>`, `<line geometry={...}>` renders a `THREE.Line` via the R3F
reconciler, which parses any `data-*` prop as a dash-separated key-path and
attempts to walk `obj.data.hercules.name` on the underlying Three.js object.
That throws `R3F: Cannot set "data-hercules-name". Ensure it is an object
before setting "hercules-name".`, kills the WebGL context, and blanks the
preview. Same story for `<path>`, `<audio>`, `<source>`, `<clippingGroup>`.

Skip these names only inside an R3F `<Canvas>` subtree so that SVG charts and
HTML media tags in the same file (rendered outside any `<Canvas>`) are still
selectable in the visual editor.
