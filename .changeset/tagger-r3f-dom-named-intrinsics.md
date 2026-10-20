---
"@usehercules/vite": patch
---

Stop tagging the R3F intrinsics `<line>`, `<path>`, `<audio>` and `<source>` in files that import `@react-three/*`, and `<clippingGroup>` everywhere. They were tagged, and R3F threw `Cannot set "data-hercules-name"` and blanked the canvas. Outside R3F files the four DOM-named elements stay tagged.
