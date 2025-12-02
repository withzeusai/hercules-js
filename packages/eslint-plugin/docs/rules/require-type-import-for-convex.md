# require-type-import-for-convex

Enforces `type` imports from `convex/_generated/dataModel` since it only contains type definitions.

## Rule Details

This rule matches **any path ending with** `convex/_generated/dataModel` (with optional `.d.ts` extension).

Examples of **incorrect** code:

```js
// ❌ Missing 'type' keyword
import { Doc, Id } from "convex/_generated/dataModel";
import { Doc } from "@/convex/_generated/dataModel";
import * as DataModel from "../convex/_generated/dataModel.d.ts";
```

Examples of **correct** code:

```js
// ✅ With 'type' keyword
import type { Doc, Id } from "convex/_generated/dataModel";
import type { Doc } from "@/convex/_generated/dataModel";
import type * as DataModel from "../convex/_generated/dataModel.d.ts";

// ✅ Other Convex imports don't need 'type'
import { api } from "convex/_generated/api";
```

**Auto-fix**: This rule automatically adds the `type` keyword when missing.
