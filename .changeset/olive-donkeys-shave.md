---
"@usehercules/vite": patch
---

Confine visual editor file access to the project root

A component ID from the editor endpoints was joined to the project root with no
containment check, so `../../../etc/hosts:1:0` resolved outside the project and
any parseable file on disk could be rewritten or have elements deleted from it.

Component IDs must now resolve to a `.jsx`/`.tsx` file inside the Vite root;
absolute paths, `..` traversal, and NUL bytes are rejected. The path is
canonicalized before use, so a symlink inside the root that points outside it —
routine in a workspace or `node_modules` layout — no longer escapes the check.
Request bodies are capped at 1 MB and answered with a 413 rather than a
connection reset, and handler errors no longer return a raw stack trace.

These endpoints still do not verify the caller's origin — that fix is
follow-up work.
