---
"@usehercules/agents": patch
---

Name the package and its version on every request the app's backend makes to Hercules, in a `Hercules-Client: agents/<version>` header beside `Hercules-Version`: starting a run, reading it and its events, cancelling it, and deleting a thread. The version is the one in the package's `package.json`, written in by the build. The page's request for a run's live stream does not carry the header yet.
