---
"@usehercules/vite": patch
---

Stop tagging the R3F intrinsics `<line>`, `<path>`, `<audio>` and `<source>` in files that import `@react-three/*`. Their names match DOM elements, so they were tagged, and R3F threw `Cannot set "data-hercules-name"` and blanked the canvas. In other files these elements stay tagged.
