import { parse } from "@babel/parser";
import * as t from "@babel/types";
import traverseModule from "@babel/traverse";
import generateModule from "@babel/generator";
import { readFile } from "fs/promises";
import path from "path";

// Extract the actual functions
const traverse = (traverseModule as any).default || traverseModule;
const generate = (generateModule as any).default || generateModule;

export interface ClassNameAnalysis {
  type: "static" | "ternary" | "template" | "complex";
  value?: string;
  condition?: string;
  trueValue?: string;
  falseValue?: string;
  expression?: string;
}

export interface AnalysisResult {
  success: boolean;
  analysis?: ClassNameAnalysis;
  error?: string;
}

// Helper to extract string value from various node types
function extractStringValue(node: any): string {
  if (t.isStringLiteral(node)) {
    return node.value;
  }
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis.map((q: any) => q.value.raw).join("");
  }
  return generate(node).code;
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

  // Expression container
  if (t.isJSXExpressionContainer(node)) {
    const expr = node.expression;

    // Ternary expression
    if (t.isConditionalExpression(expr)) {
      const condition = generate(expr.test).code;
      const trueValue = extractStringValue(expr.consequent);
      const falseValue = extractStringValue(expr.alternate);

      return {
        type: "ternary",
        condition,
        trueValue,
        falseValue,
        expression: generate(expr).code
      };
    }

    // Template literal
    if (t.isTemplateLiteral(expr)) {
      return {
        type: "template",
        expression: generate(expr).code
      };
    }

    // Other complex expressions
    return {
      type: "complex",
      expression: generate(expr).code
    };
  }

  return { type: "complex", expression: node ? generate(node).code : "" };
}

export async function analyzeComponentClassName(
  componentId: string,
  rootDir: string
): Promise<AnalysisResult> {
  try {
    // Parse component ID format: "path/to/file.tsx:line:col"
    const match = componentId.match(/^(.+):(\d+):(\d+)$/);
    if (!match) {
      return { success: false, error: `Invalid component ID format: ${componentId}` };
    }

    const [, relativePath, lineStr, colStr] = match;
    const line = parseInt(lineStr!, 10);
    const col = parseInt(colStr!, 10);
    const filePath = path.join(rootDir, relativePath!);

    let code: string;
    try {
      code = await readFile(filePath, "utf-8");
    } catch (err) {
      return { success: false, error: `Failed to read file ${filePath}: ${err}` };
    }

    // Parse the file with Babel
    let ast: any;
    try {
      ast = parse(code, {
        sourceType: "module",
        plugins: ["jsx", "typescript"],
        sourceFilename: filePath
      });
    } catch (parseError: any) {
      return { success: false, error: `Failed to parse ${filePath}: ${parseError.message}` };
    }

    let foundAnalysis: ClassNameAnalysis | undefined;

    // Traverse the AST to find the JSX element at the specified location
    traverse(ast, {
      JSXOpeningElement(path: any) {
        const loc = path.node.loc;
        if (!loc) return;

        // Check if this is the element we're looking for
        if (loc.start.line === line && Math.abs(loc.start.column - col) <= 5) {
          const attributes = path.node.attributes;

          // Find existing className attribute
          const classNameAttr = attributes.find(
            (attr: any) =>
              t.isJSXAttribute(attr) &&
              t.isJSXIdentifier(attr.name) &&
              attr.name.name === "className"
          ) as t.JSXAttribute | undefined;

          if (classNameAttr) {
            foundAnalysis = analyzeClassNameExpression(classNameAttr.value);
          } else {
            foundAnalysis = { type: "static", value: "" };
          }

          path.stop();
        }
      }
    });

    if (foundAnalysis) {
      return { success: true, analysis: foundAnalysis };
    } else {
      return { success: false, error: `Component not found at ${line}:${col}` };
    }
  } catch (error: any) {
    console.error("[Visual Editor] Error analyzing className:", error);
    return { success: false, error: error.message || String(error) };
  }
}