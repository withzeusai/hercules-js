---
"@usehercules/vite": patch
---

Tag TanStack route split modules when they load, from the route file on disk. With `tanstackStart()` or `tanstackRouter()` listed before `hercules()`, the tagger received the router plugin's regenerated code, so its `data-hercules-id` line and column did not match the route file and the visual editor could change the wrong element.
