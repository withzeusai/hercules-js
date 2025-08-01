import { parse } from "@babel/parser";
import * as t from "@babel/types";
import traverseModule from "@babel/traverse";
import generateModule from "@babel/generator";
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { type ClassNameAnalysis, type TextContentAnalysis } from "./ast-analyzer";

// Extract the actual functions
const traverse = (traverseModule as any).default || traverseModule;
const generate = (generateModule as any).default || generateModule;

export interface UpdateResult {
  success: boolean;
  filePath?: string;
  error?: string;
  analysis?: ClassNameAnalysis | TextContentAnalysis;
}

export async function updateComponentClassName(
  componentId: string,
  newClassName: string,
  rootDir: string
): Promise<UpdateResult> {
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

    let modified = false;
    let foundElements = 0;
    const nearbyElements: Array<{ line: number; col: number; tag: string }> = [];

    // Traverse the AST to find and update the JSX element
    traverse(ast, {
      JSXOpeningElement(path: any) {
        const loc = path.node.loc;
        if (!loc) return;

        foundElements++;

        // Collect nearby elements for debugging
        if (Math.abs(loc.start.line - line) <= 5) {
          const tagName = path.node.name.name || "unknown";
          nearbyElements.push({
            line: loc.start.line,
            col: loc.start.column,
            tag: tagName
          });
        }

        // Check if this is the element we're looking for
        if (loc.start.line === line && Math.abs(loc.start.column - col) <= 5) {
          const attributes = path.node.attributes;

          // Find existing className attribute
          const classNameAttrIndex = attributes.findIndex(
            (attr: any) =>
              t.isJSXAttribute(attr) &&
              t.isJSXIdentifier(attr.name) &&
              attr.name.name === "className"
          );

          // Create new className attribute with static string value
          const newClassNameAttr = t.jsxAttribute(
            t.jsxIdentifier("className"),
            t.stringLiteral(newClassName)
          );

          if (classNameAttrIndex !== -1) {
            // Update existing className
            attributes[classNameAttrIndex] = newClassNameAttr;
          } else {
            // Add new className
            attributes.push(newClassNameAttr);
          }

          modified = true;
          path.stop();
        }
      }
    });

    if (!modified) {
      const debugInfo =
        nearbyElements.length > 0
          ? ` Found ${nearbyElements.length} nearby elements: ${JSON.stringify(nearbyElements)}`
          : ` Total JSX elements found: ${foundElements}`;
      return {
        success: false,
        error: `Component not found at ${line}:${col}.${debugInfo}`
      };
    }

    // Generate the updated code
    let output: any;
    try {
      output = generate(
        ast,
        {
          retainLines: true,
          compact: false,
          concise: false,
          comments: true
        },
        code
      );
    } catch (genError) {
      return { success: false, error: `Failed to generate code: ${genError}` };
    }

    // Write the updated code back to the file
    try {
      await writeFile(filePath, output.code, "utf-8");
    } catch (writeError) {
      return { success: false, error: `Failed to write file: ${writeError}` };
    }

    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: `Unexpected error: ${error}` };
  }
}

export async function updateComponentTextContent(
  componentId: string,
  newTextContent: string,
  rootDir: string
): Promise<UpdateResult> {
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

    let modified = false;
    let foundElements = 0;
    const nearbyElements: Array<{ line: number; col: number; tag: string }> = [];

    // Traverse the AST to find and update the JSX element
    traverse(ast, {
      JSXElement(path: any) {
        const openingElement = path.node.openingElement;
        const loc = openingElement.loc;
        if (!loc) return;

        foundElements++;

        // Collect nearby elements for debugging
        if (Math.abs(loc.start.line - line) <= 5) {
          const tagName = openingElement.name.name || "unknown";
          nearbyElements.push({
            line: loc.start.line,
            col: loc.start.column,
            tag: tagName
          });
        }

        // Check if this is the element we're looking for
        if (loc.start.line === line && Math.abs(loc.start.column - col) <= 5) {
          // Clear existing children and add new text content
          path.node.children = [t.jsxText(newTextContent)];
          
          modified = true;
          path.stop();
        }
      }
    });

    if (!modified) {
      const debugInfo =
        nearbyElements.length > 0
          ? ` Found ${nearbyElements.length} nearby elements: ${JSON.stringify(nearbyElements)}`
          : ` Total JSX elements found: ${foundElements}`;
      return {
        success: false,
        error: `Component not found at ${line}:${col}.${debugInfo}`
      };
    }

    // Generate the updated code
    let output: any;
    try {
      output = generate(
        ast,
        {
          retainLines: true,
          compact: false,
          concise: false,
          comments: true
        },
        code
      );
    } catch (genError) {
      return { success: false, error: `Failed to generate code: ${genError}` };
    }

    // Write the updated code back to the file
    try {
      await writeFile(filePath, output.code, "utf-8");
    } catch (writeError) {
      return { success: false, error: `Failed to write file: ${writeError}` };
    }

    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: `Unexpected error: ${error}` };
  }
}
