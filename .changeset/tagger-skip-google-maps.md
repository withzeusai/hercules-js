---
"@usehercules/vite": patch
---

Stop tagging components imported from `@vis.gl/react-google-maps`. `<Pin>` passes every prop to the Google Maps `PinElement` constructor, which threw `Unknown property 'data-hercules-id' of PinElement` and blanked the page in the dev preview. Those components never put the attributes in the DOM, so the visual editor loses nothing.
