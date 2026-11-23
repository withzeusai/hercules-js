---
"@usehercules/vite": minor
"@usehercules/vite-tanstack": patch
---

Build the browser bundle for Safari and iOS 16. Vite 8 targets Safari 16.4 by default and leaves newer syntax from dependencies in place, such as the class static block in `@radix-ui/react-collection` 1.2.0. Safari and iPadOS 16.0 to 16.3 cannot parse it, so the whole app rendered as a blank page. CSS keeps Vite's default target. An app that sets `build.target` itself keeps its own target, and Vite 7 apps, which already target Safari 16, are unchanged.
