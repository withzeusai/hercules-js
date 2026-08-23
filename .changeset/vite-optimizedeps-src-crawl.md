---
"@usehercules/vite": patch
---

Seed the Vite dependency optimizer from every source file at dev-server startup so large apps with many lazy-loaded routes no longer trigger a mid-session re-optimize and full reload. The reload could leave react-dom bound to a previous optimizer generation of React, producing the recurring "Cannot read properties of null (reading 'useContext'/'useMemo')" crash. Only `src` is crawled, so server-only dependencies are never pre-bundled.
