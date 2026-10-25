---
"@usehercules/vite": major
---

Remove the dynamic component creator. On a Hercules dev machine it wrote a stub file for any imported component that did not exist, which hid a broken import that lint and the build would otherwise report. The `dynamicComponentCreator` option and the `dynamicComponentCreatorPlugin` export are gone; delete the option from your `hercules()` call if you passed it.
