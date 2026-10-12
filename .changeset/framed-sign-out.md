---
"@usehercules/auth": patch
---

Stop redirect sign-out from navigating an app inside an iframe, such as the App Builder preview, to the hosted end-session page, which refuses to be framed. Framed apps now send the end-session request in the background and sign out locally. Top-level sign-out and `redirectTarget: "top"` are unchanged.
