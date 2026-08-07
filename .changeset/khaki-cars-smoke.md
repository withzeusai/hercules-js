---
"@usehercules/vite": patch
---

Fix visual editor targeting the wrong element and corrupting JSX

Three defects in the locate-and-mutate path, now covered by tests:

- Elements were matched with a ±5 column tolerance, so a nested element
  starting within five columns of its parent (`<div><span>`) resolved to the
  parent — edits and deletions hit the wrong node. Matching is now exact, which
  is what the tagger emits.
- Text and class names were written as raw JSX, so a value containing `<`, `>`,
  `{`, `}` or a quote produced a file that no longer parsed. Such values are
  now emitted as an escaped expression container.
- The deletion-safety check walked `node.parent`, which Babel does not set, so
  it stopped after one hop and reported elements inside `.map()` or a ternary
  as safe to delete. It now walks `parentPath` and looks through callbacks.
