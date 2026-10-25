---
"@usehercules/vite": patch
---

Update `magic-string` to 1.x. It ships ESM only, so the component tagger now imports `MagicString` by name; the default import resolved to the module namespace in the CJS build and every file failed to tag.
