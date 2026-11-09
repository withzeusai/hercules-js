---
"@usehercules/mcp": minor
---

Add `@usehercules/mcp`: serve an MCP server from a Hercules app. `@usehercules/mcp/convex` declares tools with Convex validators and routes them from `convex/http.ts`. The package verifies Hercules Auth tokens itself and hands each tool the verified caller, so a token for the MCP server is not accepted by the app's other functions.
