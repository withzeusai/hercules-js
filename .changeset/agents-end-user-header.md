---
"@usehercules/agents": patch
---

Name the end user on every request the component makes to Hercules about a user's thread or run, not only on the request that starts the run.

- Reading a run, reading its events, stopping it, and deleting its thread now carry a `Hercules-End-User` header with the user's `tokenIdentifier`, the same string a run is started with as `end_user.token_identifier`. Starting a run carries it too, beside the body.
- The identifier is the one the component stored when the thread was opened, never one a page sent. Requests about the app's own threads, those `run` opens, carry no such header.
- An identifier a header cannot carry as it is (characters outside visible ASCII) is sent as `UTF-8''` followed by its percent-encoded UTF-8.
- A 404 on any of these requests is handled as before.

The component's `deleted_threads` table gains one optional field, `owner`, so a deleted thread's user is still known when Hercules is asked to delete it. A thread deleted before the upgrade is asked about without the header. No stored document changes shape and no function's arguments change.
