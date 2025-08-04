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
      value: node.quasis.map((q: any) => q.value.raw).join("")
    };
  }

  // Everything else is dynamic (not editable)
  return { type: "dynamic" };
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

export interface TextContentAnalysis {
  type: "static" | "expression" | "mixed" | "empty";
  value?: string;
  hasChildren: boolean;
  expression?: string;
}

export interface TextAnalysisResult {
  success: boolean;
  analysis?: TextContentAnalysis;
  error?: string;
}

// Helper to extract text content from JSX children
function extractTextContent(children: any[]): TextContentAnalysis {
  if (!children || children.length === 0) {
    return { type: "empty", hasChildren: false };
  }

  const hasNonTextChildren = children.some(child => 
    t.isJSXElement(child) || t.isJSXFragment(child)
  );

  if (hasNonTextChildren) {
    return { type: "mixed", hasChildren: true };
  }

  // Check if all children are static text
  const allStatic = children.every(child => 
    t.isJSXText(child) || 
    (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression))
  );

  if (allStatic) {
    const textContent = children.map(child => {
      if (t.isJSXText(child)) {
        return child.value;
      } else if (t.isJSXExpressionContainer(child) && t.isStringLiteral(child.expression)) {
        return child.expression.value;
      }
      return "";
    }).join("").trim();

    return { type: "static", value: textContent, hasChildren: false };
  }

  // Handle expression content
  const expressions = children.filter(child => 
    t.isJSXExpressionContainer(child) && !t.isStringLiteral(child.expression)
  );

  if (expressions.length > 0) {
    const expression = generate(expressions[0]).code;
    return { type: "expression", expression, hasChildren: false };
  }

  return { type: "mixed", hasChildren: true };
}

export async function analyzeComponentTextContent(
  componentId: string,
  rootDir: string
): Promise<TextAnalysisResult> {
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

    let foundAnalysis: TextContentAnalysis | undefined;

    // Traverse the AST to find the JSX element at the specified location
    traverse(ast, {
      JSXElement(path: any) {
        const openingElement = path.node.openingElement;
        const loc = openingElement.loc;
        if (!loc) return;

        // Check if this is the element we're looking for
        if (loc.start.line === line && Math.abs(loc.start.column - col) <= 5) {
          const children = path.node.children;
          foundAnalysis = extractTextContent(children);
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
    console.error("[Visual Editor] Error analyzing text content:", error);
    return { success: false, error: error.message || String(error) };
  }
}