---
"@usehercules/vite": patch
---

Answer 404, as Vite does, when a page asks for a TanStack route split module (`?tsr-split=component`) whose route file was deleted. The component tagger read the file itself and threw, so the request failed with a 500 that Vite also logged in every open page as "[vite] Internal Server Error ENOENT".
