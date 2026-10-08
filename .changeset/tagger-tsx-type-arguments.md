---
"@usehercules/vite": patch
---

Insert the component tagger's data attributes after TSX type arguments, so generic components such as `<TextField<Foo> name="a" />` no longer produce invalid code and a dev server "Expression expected" error.
