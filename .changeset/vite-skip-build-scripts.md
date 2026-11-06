---
"@usehercules/vite": patch
"@usehercules/vite-tanstack": patch
---

Exclude Vite and its plugins (`vite`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `@vitejs/plugin-react-swc`) from the dependency optimizer. A Node script under `src` that imports them, such as a prerender runner, or an app that lists one under `dependencies`, made Vite bundle `@tailwindcss/vite` and its native binary for the browser, which failed every dev server start.
