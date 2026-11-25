---
"@usehercules/vite-tanstack": patch
---

Fix "Importing binding name 'x' is not found" in dev for a route whose loader and component use the same module-level value, such as a query. TanStack Router moves that value into a shared module (`?tsr-shared=1`), but it only learns what to move when it compiles the route file. When the dev server compiled the shared module first, it served the whole route file in its place, without the export, and the page failed until the route file changed or the dev server restarted. The route file is now compiled first, so the shared module and the split component always match it. This works around TanStack/router#8754 and will be removed once TanStack Router ships the fix.
