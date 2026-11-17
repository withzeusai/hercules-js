---
"@usehercules/agents": patch
---

Harden deleting a thread, the hourly limit, and page actions.

- `deleteThread` asks Hercules to delete only a thread Hercules took a run on. Hercules takes a run only for the user it was sent for, so a run it took is what tells the component that the thread under that id at Hercules is the caller's. A thread whose runs Hercules all refused, or never got, is deleted in the app alone. One deleted while its first run is still being started is deleted at Hercules once Hercules says it has that run. A thread with a run Hercules took is deleted as before.
- `limits.runsPerUserPerHour` holds across `deleteThread`. The runs of a deleted thread count until an hour after they were sent, where deleting the thread used to give them back.
- A page action a run was not started with is dropped when Hercules delivers it, with a warning in the Convex logs, so no page lists or claims it. In the page, a handler runs only when it is a function the page set under that exact name: a name every object answers to, such as `constructor` or `toString`, finds none.
- The README says what a page action handler may do with its arguments, which a model writes, and its examples check the id they navigate with. It names `run` and `readThreadDetails` as server-only: neither reads `ctx.auth`, and `support.api()` exports neither.

The component's schema gains one table, `purged_run_starts`, and one optional field, `deleted_threads.unconfirmedRunId`. No stored document changes shape and no function's arguments change, so an app on 0.1.x upgrades with a plain deploy.
