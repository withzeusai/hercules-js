---
"@usehercules/auth-tanstack": patch
---

Log server-side errors whenever an error status is returned. The sign-in handler no longer swallows the underlying error behind the generic "Failed to start sign-in" response, and callback failures are logged with their HTTP status and cause, making issues like OIDC discovery failures diagnosable from the server logs.
