import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "./_helpers";

type Options = [];
type MessageIds = "requireTypeImport";

/**
 * Check if the import path is a convex dataModel import
 * Matches any path ending with convex/_generated/dataModel (with optional .d.ts extension)
 * Examples:
 * - convex/_generated/dataModel
 * - convex/_generated/dataModel.d.ts
 * - @/convex/_generated/dataModel
 * - ../convex/_generated/dataModel
 * - ~/convex/_generated/dataModel
 * - src/convex/_generated/dataModel.d.ts
 */
function isConvexDataModelImport(importPath: string): boolean {
  // Regex: any characters (or none) followed by convex/_generated/dataModel with optional .d.ts extension
  const convexDataModelRegex = /^(.*)convex\/_generated\/dataModel(\.d\.ts)?$/;
  return convexDataModelRegex.test(importPath);
}

export default createRule<Options, MessageIds>({
  name: "require-type-import-for-convex",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require 'type' keyword when importing from convex/_generated/dataModel",
    },
    schema: [], // No configuration options
    messages: {
      requireTypeImport:
        "Imports from 'convex/_generated/dataModel' must use the 'type' keyword since it's not a module",
    },
    fixable: "code",
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        // Check if the import is from convex/_generated/dataModel
        if (
          typeof node.source.value === "string" &&
          isConvexDataModelImport(node.source.value)
        ) {
          // Check if it's not a type import
          if (node.importKind !== "type") {
            context.report({
              node,
              messageId: "requireTypeImport",
              fix(fixer) {
                // Add 'type' after 'import'
                const importKeyword = context.sourceCode.getFirstToken(node);
                if (importKeyword) {
                  return fixer.insertTextAfter(importKeyword, " type");
                }
                return null;
              },
            });
          }
        }
      },
    };
  },
});
