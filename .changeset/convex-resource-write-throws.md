---
"@usehercules/convex": minor
---

`access.resource.write` now returns `Promise<ResourceNode>` and fails loud instead of silently no-op'ing.

Previously it returned `ResourceNode | null` where null meant nothing was written (unresolved tenant, undeclared resource type) and a mismatched `parent` silently dropped the parent edge; callers that discarded the result could commit app rows with no backing access node. It now throws `ConvexError { code: "ACCESS_DENIED", reasonCode: "mirror_not_ready" }` (temporary) when the mirror has no tenant yet, and `ConvexError { code: "IAM_CONFIG" }` when the type is undeclared or the supplied parent does not match the type's declared parent, rolling the calling mutation back so app data and the access graph stay consistent.
