import { createRuleTester } from "./test-helper";
import rule from "./require-type-import-for-convex";

const ruleTester = createRuleTester("require-type-import-for-convex", rule);

const validCases = [
  // Valid: type import from convex/_generated/dataModel
  {
    code: `
      import type { Doc, Id } from "convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { User, Post } from "convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type * as DataModel from "convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { } from "convex/_generated/dataModel";
    `,
  },
  // Valid: type import with .d.ts extension
  {
    code: `
      import type { Doc, Id } from "convex/_generated/dataModel.d.ts";
    `,
  },
  {
    code: `
      import type * as DataModel from "convex/_generated/dataModel.d.ts";
    `,
  },
  // Valid: type import with @/ path alias
  {
    code: `
      import type { Doc, Id } from "@/convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { User } from "@/convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type * as DataModel from "@/convex/_generated/dataModel";
    `,
  },
  // Valid: type import with @/ path alias and .d.ts extension
  {
    code: `
      import type { Doc, Id } from "@/convex/_generated/dataModel.d.ts";
    `,
  },
  {
    code: `
      import type * as DataModel from "@/convex/_generated/dataModel.d.ts";
    `,
  },
  // Valid: regular imports from other modules
  {
    code: `
      import { api } from "convex/_generated/api";
    `,
  },
  {
    code: `
      import { mutation, query } from "convex/_generated/server";
    `,
  },
  {
    code: `
      import React from "react";
    `,
  },
  {
    code: `
      import { useState } from "react";
    `,
  },
  // Valid: other convex paths without type requirement
  {
    code: `
      import { Id } from "convex/_generated/other";
    `,
  },
  {
    code: `
      import { Doc } from "convex/values";
    `,
  },
  // Valid: type imports with various path prefixes
  {
    code: `
      import type { Doc } from "../convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { Doc } from "~/convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { Doc } from "../../convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { Doc } from "./convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { Doc } from "src/convex/_generated/dataModel";
    `,
  },
  {
    code: `
      import type { Doc } from "../convex/_generated/dataModel.d.ts";
    `,
  },
  {
    code: `
      import type { Doc } from "~/convex/_generated/dataModel.d.ts";
    `,
  },
  // Valid: paths that don't match the pattern (no enforcement)
  {
    code: `
      import { Doc } from "convex/_generated/other";
    `,
  },
  {
    code: `
      import { Doc } from "convex/dataModel";
    `,
  },
  {
    code: `
      import { Doc } from "convex_generated_dataModel";
    `,
  },
];

const invalidCases = [
  // Invalid: regular import from convex/_generated/dataModel
  {
    code: `
      import { Doc, Id } from "convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { User } from "convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import * as DataModel from "convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { } from "convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  // Invalid: default import from convex/_generated/dataModel
  {
    code: `
      import DataModel from "convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  // Invalid: mixed named and default imports
  {
    code: `
      import DataModel, { Doc, Id } from "convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  // Invalid: regular import with .d.ts extension
  {
    code: `
      import { Doc, Id } from "convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import * as DataModel from "convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import DataModel from "convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  // Invalid: regular import with @/ path alias
  {
    code: `
      import { Doc, Id } from "@/convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { User } from "@/convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import * as DataModel from "@/convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import DataModel from "@/convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  // Invalid: regular import with @/ path alias and .d.ts extension
  {
    code: `
      import { Doc, Id } from "@/convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import * as DataModel from "@/convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import DataModel from "@/convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  // Invalid: regular imports with various path prefixes
  {
    code: `
      import { Doc } from "../convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { Doc } from "~/convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { Doc } from "../../convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { Doc } from "./convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { Doc } from "src/convex/_generated/dataModel";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { Doc } from "../convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import { Doc } from "~/convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
  {
    code: `
      import * as DataModel from "./convex/_generated/dataModel.d.ts";
    `,
    errors: [
      {
        messageId: "requireTypeImport",
      },
    ],
  },
];

ruleTester.run(validCases, invalidCases);
