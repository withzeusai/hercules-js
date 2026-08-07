import { parse } from "@babel/parser";
import * as t from "@babel/types";
import traverseModule from "@babel/traverse";
import { readFile } from "fs/promises";
import { resolveComponentId } from "./component-id";

// Extract the actual functions
const traverse = (traverseModule as any).default || traverseModule;

export interface ClassNameAnalysis {
  type: "static" | "dynamic";
  value?: string;
}

export interface AnalysisResult {
  success: boolean;
  analysis?: ClassNameAnalysis;
  error?: string;
}

// Helper function to analyze className expressions
export function analyzeClassNameExpression(node: any): ClassNameAnalysis {
  if (!node) {
    return { type: "static", value: "" };
  }

  // Static string literal
  if (t.isStringLiteral(node)) {
    return { type: "static", value: node.value };
  }

  // Expression container - check what's inside
  if (t.isJSXExpressionContainer(node)) {
    return analyzeClassNameExpression(node.expression);
  }

  // Template literal with no expressions (treat as static string)
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return {
      type: "static",
      value: node.quasis.map((q: any) => q.value.raw).join(""),
    };
  }

  // Everything else is dynamic (not editable)
  return { type: "dynamic" };
}

export interface TextContentAnalysis {
  type: "static" | "dynamic";
  value?: string;
  reason?: "has-children" | "dynamic-content";
}

export interface ElementTypeAnalysis {
  type: "static" | "dynamic";
  reason?: "conditional-expression" | "complex-parent" | "map-expression";
}

export interface TextAnalysisResult {
  success: boolean;
  analysis?: TextContentAnalysis;
  error?: string;
}

// Unified analysis interfaces
export interface UnifiedElementAnalysis {
  success: boolean;
  componentId: string;
  className?: ClassNameAnalysis;
  textContent?: TextContentAnalysis;
  elementType?: ElementTypeAnalysis;
  error?: string;
}

// Helper to analyze if element can be safely deleted
function analyzeElementDeletionSafety(path: any): ElementTypeAnalysis {
  // Walk up the AST to check the element's context.
  // Note: this walks `parentPath`, not `node.parent` — Babel nodes carry no
  // parent pointer, so walking nodes stops dead after a single hop and reports
  // everything as safe to delete.
  let current = path.parentPath;

  while (current) {
    const node = current.node;

    // Check if element is in a conditional expression (ternary)
    if (t.isConditionalExpression(node)) {
      return {
        type: "dynamic",
        reason: "conditional-expression",
      };
    }

    // Check if element is in array map expressions
    if (
      t.isCallExpression(node) &&
      t.isMemberExpression(node.callee) &&
      t.isIdentifier(node.callee.property) &&
      node.callee.property.name === "map"
    ) {
      return {
        type: "dynamic",
        reason: "map-expression",
      };
    }

    // Check for other complex expressions that might make deletion unsafe
    if (t.isLogicalExpression(node) || t.isSequenceExpression(node) || t.isArrayExpression(node)) {
      return {
        type: "dynamic",
        reason: "complex-parent",
      };
    }

    // Stop checking at component boundaries, but walk through callbacks:
    // in `items.map((i) => <li/>)` the arrow function is the callback, and the
    // `.map()` that makes deletion unsafe sits directly above it.
    if (t.isFunction(node)) {
      const parentNode = current.parentPath?.node;
      const isCallback =
        parentNode &&
        t.isCallExpression(parentNode) &&
        parentNode.arguments.some((argument: any) => argument === node);
      if (!isCallback) {
        break;
      }
    } else if (t.isJSXElement(node)) {
      break;
    }

    current = current.parentPath;
  }

  // If we didn't find any problematic parents, deletion should be safe
  return { type: "static" };
}

// Helper to extract text content from JSX children
function extractTextContent(children: any[]): TextContentAnalysis {
  if (!children || children.length === 0) {
    return { type: "static", value: "" };
  }

  // Check if has nested JSX elements or fragments
  const hasNonTextChildren = children.some(
    (child) => t.isJSXElement(child) || t.isJSXFragment(child),
  );

  if (hasNonTextChildren) {
    return { type: "dynamic", reason: "has-children" };
  }

  // Check if all children are static text
  const allStatic = children.every(
    (child) =>
      t.isJSXText(child) ||
      (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression)),
  );

  if (allStatic) {
    const textContent = children
      .map((child) => {
        if (t.isJSXText(child)) {
          return child.value;
        } else if (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression)) {
          return child.expression.value;
        }
        return "";
      })
      .join("")
      .trim();

    return { type: "static", value: textContent };
  }

  // Has dynamic expressions
  return { type: "dynamic", reason: "dynamic-content" };
}

// Unified analyze function that combines className and textContent analysis
export async function analyzeElement(
  componentId: string,
  rootDir: string,
): Promise<UnifiedElementAnalysis> {
  try {
    // Parse component ID format: "path/to/file.tsx:line:col"
    const resolved = await resolveComponentId(componentId, rootDir);
    if (!resolved.ok) {
      return { success: false, componentId, error: resolved.error };
    }

    const { filePath, line, column: col } = resolved.value;

    // Read file once
    let code: string;
    try {
      code = await readFile(filePath, "utf-8");
    } catch (err) {
      return {
        success: false,
        componentId,
        error: `Failed to read file ${filePath}: ${err}`,
      };
    }

    // Parse the file once with Babel
    let ast: any;
    try {
      ast = parse(code, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        sourceFilename: filePath,
      });
    } catch (parseError: any) {
      return {
        success: false,
        componentId,
        error: `Failed to parse ${filePath}: ${parseError.message}`,
      };
    }

    let classNameAnalysis: ClassNameAnalysis | undefined;
    let textContentAnalysis: TextContentAnalysis | undefined;
    let elementTypeAnalysis: ElementTypeAnalysis | undefined;
    let elementFound = false;

    // Single traversal to find and analyze the element
    traverse(ast, {
      JSXElement(path: any) {
        const openingElement = path.node.openingElement;
        const loc = openingElement.loc;
        if (!loc) return;

        // Check if this is the element we're looking for. The match is exact:
        // the tagger derives the ID from this same Babel location, and a fuzzy
        // column window selects the enclosing element when two start on one line.
        if (loc.start.line === line && loc.start.column === col) {
          elementFound = true;

          // Analyze className from opening element
          const attributes = openingElement.attributes;
          const classNameAttr = attributes.find(
            (attr: any) =>
              t.isJSXAttribute(attr) &&
              t.isJSXIdentifier(attr.name) &&
              attr.name.name === "className",
          ) as t.JSXAttribute | undefined;

          if (classNameAttr) {
            classNameAnalysis = analyzeClassNameExpression(classNameAttr.value);
          } else {
            classNameAnalysis = { type: "static", value: "" };
          }

          // Analyze text content from children
          const children = path.node.children;
          textContentAnalysis = extractTextContent(children);

          // Analyze element deletion safety
          elementTypeAnalysis = analyzeElementDeletionSafety(path);

          path.stop();
        }
      },
    });

    if (elementFound) {
      const result: UnifiedElementAnalysis = {
        success: true,
        componentId,
      };

      if (classNameAnalysis) {
        result.className = classNameAnalysis;
      }

      if (textContentAnalysis) {
        result.textContent = textContentAnalysis;
      }

      if (elementTypeAnalysis) {
        result.elementType = elementTypeAnalysis;
      }

      return result;
    } else {
      return {
        success: false,
        componentId,
        error: `Component not found at ${line}:${col}`,
      };
    }
  } catch (error: any) {
    console.error("[Visual Editor] Error analyzing element:", error);
    return {
      success: false,
      componentId,
      error: error.message || String(error),
    };
  }
}
