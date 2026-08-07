import { parse } from "@babel/parser";
import * as t from "@babel/types";
import traverseModule from "@babel/traverse";
import generateModule from "@babel/generator";
import { readFile, writeFile } from "fs/promises";
import { type ClassNameAnalysis, type TextContentAnalysis } from "./ast-analyzer";
import { resolveComponentId } from "./component-id";

// Extract the actual functions
const traverse = (traverseModule as any).default || traverseModule;
const generate = (generateModule as any).default || generateModule;

export interface UpdateResult {
  success: boolean;
  filePath?: string;
  error?: string;
  analysis?: ClassNameAnalysis | TextContentAnalysis;
}

/** Characters that terminate a JSX text node or attribute value. */
const JSX_UNSAFE = /["'<>{}]/;

/**
 * Build a JSX attribute value that survives `<`, `>`, `{`, `}` and quotes.
 *
 * A bare string literal is printed as `attr="value"`, so any of those
 * characters produce source that no longer parses. Wrapping in an expression
 * container (`attr={"value"}`) makes the generator escape the string properly.
 */
function jsxSafeAttributeValue(value: string): t.StringLiteral | t.JSXExpressionContainer {
  return JSX_UNSAFE.test(value)
    ? t.jsxExpressionContainer(t.stringLiteral(value))
    : t.stringLiteral(value);
}

/**
 * Build JSX children for a run of text, escaping the same way.
 */
function jsxSafeChildren(text: string): Array<t.JSXText | t.JSXExpressionContainer> {
  if (text.trim() === "") {
    return [];
  }
  return JSX_UNSAFE.test(text)
    ? [t.jsxExpressionContainer(t.stringLiteral(text))]
    : [t.jsxText(text)];
}

export async function updateComponentElement(
  componentId: string,
  updates: {
    className?: string;
    textContent?: string;
  },
  rootDir: string,
): Promise<UpdateResult> {
  try {
    // Parse component ID format: "path/to/file.tsx:line:col"
    const resolved = await resolveComponentId(componentId, rootDir);
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    const { filePath, line, column: col } = resolved.value;

    let code: string;
    try {
      code = await readFile(filePath, "utf-8");
    } catch (err) {
      return {
        success: false,
        error: `Failed to read file ${filePath}: ${err}`,
      };
    }

    // Parse the file with Babel
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
        error: `Failed to parse ${filePath}: ${parseError.message}`,
      };
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
            tag: tagName,
          });
        }

        // Check if this is the element we're looking for. Exact match: a fuzzy
        // column window selects the enclosing element when two start on one line.
        if (loc.start.line === line && loc.start.column === col) {
          // Update className if provided
          if (updates.className !== undefined) {
            const classNameAttr = openingElement.attributes.find(
              (attr: any) => attr.name && attr.name.name === "className",
            );

            if (updates.className === "") {
              // Remove className attribute if new value is empty
              openingElement.attributes = openingElement.attributes.filter(
                (attr: any) => !(attr.name && attr.name.name === "className"),
              );
            } else {
              if (classNameAttr) {
                // Update existing className
                classNameAttr.value = jsxSafeAttributeValue(updates.className);
              } else {
                // Add new className attribute
                openingElement.attributes.push(
                  t.jsxAttribute(
                    t.jsxIdentifier("className"),
                    jsxSafeAttributeValue(updates.className),
                  ),
                );
              }
            }
          }

          // Update text content if provided
          if (updates.textContent !== undefined) {
            // Replace children with the new text, escaped so that characters
            // like `<` or `{` cannot terminate the element
            path.node.children = jsxSafeChildren(updates.textContent);
          }

          modified = true;
          path.stop();
        }
      },
    });

    if (!modified) {
      const debugInfo =
        nearbyElements.length > 0
          ? ` Found ${nearbyElements.length} nearby elements: ${JSON.stringify(nearbyElements)}`
          : ` Total JSX elements found: ${foundElements}`;
      return {
        success: false,
        error: `Component not found at ${line}:${col}.${debugInfo}`,
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
          comments: true,
        },
        code,
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
    const resolved = await resolveComponentId(componentId, rootDir);
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }

    const { filePath, line, column: col } = resolved.value;

    let code: string;
    try {
      code = await readFile(filePath, "utf-8");
    } catch (err) {
      return {
        success: false,
        error: `Failed to read file ${filePath}: ${err}`,
      };
    }

    // Parse the file with Babel
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
        error: `Failed to parse ${filePath}: ${parseError.message}`,
      };
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
            tag: tagName,
          });
        }

        // Check if this is the element we're looking for. Exact match: deleting
        // the wrong element is unrecoverable, and a ±5 column window resolves a
        // nested element to its parent.
        if (loc.start.line === line && loc.start.column === col) {
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
        if (loc.start.line === line && loc.start.column === col) {
          // Remove the fragment from its parent
          path.remove();

          modified = true;
          path.stop();
        }
      },
    });

    if (!modified) {
      const debugInfo =
        nearbyElements.length > 0
          ? ` Found ${nearbyElements.length} nearby elements: ${JSON.stringify(nearbyElements)}`
          : ` Total JSX elements found: ${foundElements}`;
      return {
        success: false,
        error: `Component not found at ${line}:${col}.${debugInfo}`,
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
          comments: true,
        },
        code,
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
