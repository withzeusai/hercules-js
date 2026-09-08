---
"@usehercules/vite-tanstack": minor
---

Add `@usehercules/vite-tanstack`, a shared Vite and Vitest configuration for Hercules TanStack Start applications.

`defineConfig()` assembles the standard plugin stack (TanStack devtools, Tailwind, `@usehercules/vite`, the Cloudflare Vite plugin targeting the `ssr` environment, TanStack Start, and plugin-react), the `@` and `@/convex` aliases, React and TanStack dedupe, and the dev-server shape the Hercules preview expects. When `HERCULES_DEV_SERVER=true` it also pins the port, ignores changes under agent-managed directories, and waits for files to settle before triggering HMR. Plain Vite config values or a per-plugin options object can be passed to customise it.

`defineVitestConfig()` from `@usehercules/vite-tanstack/vitest` shares the same aliases and defines the `convex` (edge runtime) and `frontend` (jsdom) test projects.
