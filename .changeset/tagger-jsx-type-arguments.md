---
"@usehercules/vite": patch
---

Tag JSX elements after their type arguments. An element with explicit type arguments, such as `<Select<Option> value={value} />`, got its `data-hercules-id` and `data-hercules-name` attributes between the tag name and the type arguments, which is a syntax error, so the dev preview failed to load.
