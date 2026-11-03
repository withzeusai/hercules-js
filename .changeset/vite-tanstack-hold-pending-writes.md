---
"@usehercules/vite-tanstack": patch
---

Render a page requested right after an edit with the edited code on Hercules dev machines. The watcher there waits about a second for a written file to settle before Vite reloads the Worker, and a page requested in that second was server-rendered from the old module while the browser loaded the new one, so React reported a hydration mismatch, often on `data-hercules-id` attributes shifted by the edit's line count. Page requests now wait while a write to a module the Worker loaded is pending, then follow the reload as before. A request is still never held longer than 3 seconds.
