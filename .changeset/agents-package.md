---
"@usehercules/agents": minor
---

Add `@usehercules/agents`: serve an app's tools to Hercules agents. `@usehercules/agents/convex` declares tools with Convex validators (`defineTools`, `tool`) and routes them from `convex/http.ts` as an MCP server. The package verifies Hercules Auth tokens itself and hands each tool the verified caller, so a token for the tools is not accepted by the app's other functions.
