import { TSESTree } from "@typescript-eslint/utils";
import {
  getJSXElementName,
  getJSXAttributeValue,
  isEmptyStringLiteral,
} from "../utils/ast-utils";
import { createRule } from "./_helpers";

type Options = [];
type MessageIds = "emptySelectValue" | "missingSelectValue";

export default createRule<Options, MessageIds>({
  name: "no-empty-select-value",
  meta: {
    type: "problem",
    docs: {
      description: "Disallow empty string values in SelectItem components",
    },
    schema: [], // No configuration options
    messages: {
      emptySelectValue: "SelectItem value must not be an empty string",
      missingSelectValue: "SelectItem must have a value prop",
    },
    fixable: undefined,
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        const componentName = getJSXElementName(node);

        // Only check SelectItem components
        if (componentName !== "SelectItem") {
          return;
        }

        // Find the value attribute
        let valueAttribute: TSESTree.JSXAttribute | undefined;

        for (const attr of node.attributes) {
          if (
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier" &&
            attr.name.name === "value"
          ) {
            valueAttribute = attr;
            break;
          }
        }

        // Check if value prop is missing
        if (!valueAttribute) {
          context.report({
            node,
            messageId: "missingSelectValue",
          });
          return;
        }

        const value = getJSXAttributeValue(valueAttribute);

        // Check for empty string literal
        if (value && isEmptyStringLiteral(value)) {
          context.report({
            node: valueAttribute,
            messageId: "emptySelectValue",
          });
          return;
        }

        // Check for empty template literal
        if (
          value &&
          value.type === "TemplateLiteral" &&
          value.quasis.length === 1 &&
          value.quasis[0].value.raw === ""
        ) {
          context.report({
            node: valueAttribute,
            messageId: "emptySelectValue",
          });
        }
      },
    };
  },
});
