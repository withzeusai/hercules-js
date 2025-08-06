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

export async function updateComponentElement(
  componentId: string,
  updates: {
    className?: string;
    textContent?: string;
  },
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
          // Update className if provided
          if (updates.className !== undefined) {
            const classNameAttr = openingElement.attributes.find(
              (attr: any) => attr.name && attr.name.name === "className"
            );

            if (updates.className === "") {
              // Remove className attribute if new value is empty
              openingElement.attributes = openingElement.attributes.filter(
                (attr: any) => !(attr.name && attr.name.name === "className")
              );
            } else {
              if (classNameAttr) {
                // Update existing className
                classNameAttr.value = t.stringLiteral(updates.className);
              } else {
                // Add new className attribute
                openingElement.attributes.push(
                  t.jsxAttribute(t.jsxIdentifier("className"), t.stringLiteral(updates.className))
                );
              }
            }
          }

          // Update text content if provided
          if (updates.textContent !== undefined) {
            // Clear existing children
            path.node.children = [];

            // Add new text content as a JSXText node
            if (updates.textContent.trim() !== "") {
              path.node.children.push(t.jsxText(updates.textContent));
            }
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

export async function deleteComponent(componentId: string, rootDir: string): Promise<UpdateResult> {
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

    // Traverse the AST to find and delete the JSX element
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
          // Remove the element from its parent
          path.remove();

          modified = true;
          path.stop();
        }
      },
      JSXFragment(path: any) {
        const loc = path.node.loc;
        if (!loc) return;

        foundElements++;

        // Check if this is the fragment we're looking for
        if (loc.start.line === line && Math.abs(loc.start.column - col) <= 5) {
          // Remove the fragment from its parent
          path.remove();

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
