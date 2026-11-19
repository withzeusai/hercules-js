---
"@usehercules/agents": patch
---

Treat a run status the package does not know as a run that is still going.

- The statuses a run ends with are a closed list: `completed`, `failed`, `cancelled`, `capped`. Every other status, one added to the API later among them, is a run that is going. It used to read as over, and a run read with such a status could not be read at all.
- `isFinalStatus` takes any string, and is true only for those four.
- A run in a status the package does not know keeps its thread's `activeRun`, with `status: "running"`, so a page shows it as going and can stop it. `onRunFinished` is not called for it, and `send` on its thread throws `thread_busy`, as for any run that is going.
- A run is kept open for as long as Hercules answers that it is going, and is looked at every half hour at most. It used to be failed, and stopped at Hercules, a day after it was sent. A run is now failed only once nothing was heard of it for a day (no event delivered, and no answer that it is going), or a day after it was sent when it was asked to stop.
- A run Hercules reports with a status the package does not know and a `finished_at` has ended: it is recorded as `failed` with the code `run_failed` (or the run's own error), and keeps the reply it wrote.
- A thread deleted before its first start was answered is still deleted at Hercules when that run reads with a status the package does not know.

The component's `runs` table gains one optional field, `goingAt`. No stored document changes shape and no function's arguments change, so an app on 0.2.0 upgrades with a plain deploy.
