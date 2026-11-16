---
"@usehercules/agents": minor
---

Embed a Hercules agent's chat with TanStack AI. `herculesConnection` in `@usehercules/agents/tanstack` is a TanStack AI connection that sends through the app's Convex `send` mutation and streams the run's live events as AG-UI chunks, so `useChat` and the headless kit in `@tanstack/ai-react/ui` render the reply with the app's own components. With `persistence: true` the chat reads the thread from Convex on mount and joins a reply still being written; `useThreadSync` shows replies from other tabs. Page actions run in one tab and reach TanStack as tool calls with the result "sent to the page", so TanStack never starts a second run. `send` now also opens a thread under a new UUID or ULID the page chose, as a TanStack chat names its thread before the first message.
