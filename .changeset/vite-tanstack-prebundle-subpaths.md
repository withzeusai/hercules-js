---
"@usehercules/vite-tanstack": patch
---

Bundle `date-fns/locale`, `react-day-picker/locale`, `@phosphor-icons/react/ssr`, `@phosphor-icons/react/dist/ssr` and `zustand/middleware` up front when the app declares their package. A package name does not cover a subpath, so the first import of one after the server started made Vite bundle the dependencies again in the browser and the Worker and reload the page, which dropped requests in flight. On Hercules dev machines from October 29 to November 4 `date-fns/locale` did this in about 200 TanStack Start apps and the Phosphor server entry in 60.
