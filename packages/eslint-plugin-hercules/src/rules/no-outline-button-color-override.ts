import { TSESTree } from "@typescript-eslint/utils";
import { getJSXElementName, getJSXAttributeValue } from "../utils/ast-utils";
import { createRule } from "./_helpers";

type Options = [];
type MessageIds = "outlineButtonColorOverride";

// Regex patterns for Tailwind color classes
const TAILWIND_COLOR_PATTERNS = [
  // Text colors: text-{color}-{shade} or text-{color}
  /\btext-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|transparent|current|inherit)(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?\b/,
  // Background colors: bg-{color}-{shade} or bg-{color}
  /\bbg-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|transparent|current|inherit)(?:-(?:50|100|200|300|400|500|600|700|800|900|950))?\b/,
];

function containsTailwindColor(className: string): boolean {
  return TAILWIND_COLOR_PATTERNS.some((pattern) => pattern.test(className));
}

export default createRule<Options, MessageIds>({
  name: "no-outline-button-color-override",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow text/bg color classes on Button components with variant="outline"',
    },
    schema: [], // No configuration options
    messages: {
      outlineButtonColorOverride:
        'Button with variant="outline" should not have text or background color classes in className. Outline buttons have their own color scheme which is difficult to override properly.',
    },
    fixable: undefined,
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement) {
        const componentName = getJSXElementName(node);

        // Only check Button components
        if (componentName !== "Button") {
          return;
        }

        // Find variant and className attributes
        let variantAttribute: TSESTree.JSXAttribute | undefined;
        let classNameAttribute: TSESTree.JSXAttribute | undefined;

        for (const attr of node.attributes) {
          if (
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier"
          ) {
            if (attr.name.name === "variant") {
              variantAttribute = attr;
            } else if (attr.name.name === "className") {
              classNameAttribute = attr;
            }
          }
        }

        // Check if variant is "outline"
        if (!variantAttribute) {
          return;
        }

        const variantValue = getJSXAttributeValue(variantAttribute);

        // Check if variant is literally "outline"
        const isOutlineVariant =
          (variantValue?.type === "Literal" &&
            variantValue.value === "outline") ||
          (variantValue?.type === "TemplateLiteral" &&
            variantValue.quasis.length === 1 &&
            variantValue.quasis[0].value.raw === "outline");

        if (!isOutlineVariant) {
          return;
        }

        // Check if className contains color classes
        if (!classNameAttribute) {
          return;
        }

        const classNameValue = getJSXAttributeValue(classNameAttribute);

        // Check string literal className
        if (
          classNameValue?.type === "Literal" &&
          typeof classNameValue.value === "string"
        ) {
          if (containsTailwindColor(classNameValue.value)) {
            context.report({
              node: classNameAttribute,
              messageId: "outlineButtonColorOverride",
            });
          }
        }

        // Check template literal className
        else if (classNameValue?.type === "TemplateLiteral") {
          // Check the static parts of the template
          for (const quasi of classNameValue.quasis) {
            if (containsTailwindColor(quasi.value.raw)) {
              context.report({
                node: classNameAttribute,
                messageId: "outlineButtonColorOverride",
              });
              break;
            }
          }
        }
      },
    };
  },
});
