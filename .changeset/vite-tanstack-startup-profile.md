---
"@usehercules/vite-tanstack": minor
---

Log a `[hercules:startup-profile]` line once the dev server has started on the Hercules dev machine. It times the config load, each plugin's startup hooks, each dependency optimizer run per environment and the first page, so slow starts can be traced on real machines. Set `HERCULES_STARTUP_PROFILE=0` or `1` to switch it per machine, or pass `startupProfile: false`.
