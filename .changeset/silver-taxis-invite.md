---
"@usehercules/vite": minor
---

Keep component tagging out of production builds

The component tagger and visual editor plugins are now `apply: "serve"`, so
they never run during `vite build`. Built output contains no `data-hercules-id`
/ `data-hercules-name` attributes and no injected editor script, giving
published sites white-label markup. Previously the tagger ran in builds
unconditionally, and the editor's script tag could leak into built HTML when
`NODE_ENV` was unset during the build.
