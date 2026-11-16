---
"@usehercules/agents": minor
---

Talk to a Hercules agent from a Convex app. `@usehercules/agents/convex.config` is a Convex component that keeps an agent's threads, runs and messages in the app's own deployment, and `HerculesAgents` in `@usehercules/agents/convex` starts runs from the app's mutations (`send`, `run`), reads a user's thread (`readThread`), and routes the events Hercules delivers (`registerRoutes`). `useAgentThread` in `@usehercules/agents/react` streams the reply live and runs page actions in one tab.
