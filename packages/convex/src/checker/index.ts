import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";

// ---------------------------------------------------------------------------
// Build-time IAM static checker for @usehercules/convex apps.
// ---------------------------------------------------------------------------
//
// Validates an app's Convex source against its .hercules/iam.jsonc catalog so a
// permission or resource-type typo fails the build instead of failing at
// runtime. It is deliberately small and membership-only: it does not model the
// runtime ReBAC engine, it only checks that the permission and resource-type
// STRING LITERALS the code references are declared in the catalog.
//
// What it scans in the createAccess surface:
//   - The `permission` option on the auth-aware builders protectedQuery /
//     protectedMutation / protectedAction (any builder definition object with a
//     handler). The value may be a single key, a bare array (allOf), OR an
//     { anyOf: [...] } / { allOf: [...] } set; every string literal is validated.
//   - The permission argument to access.hasPermissions(ctx, "app.x:y", ...) and
//     access.requirePermissions(ctx, ...) - single key, array, or anyOf/allOf set.
//   - Resource-type literals in resource refs: the `resource` option, the args
//     to resource.write / resource.get / resource.list, and nested `parent`
//     refs (any { type: "app.x", externalId | parent }).
//
// It also enforces that a permission-guarded function uses the PROTECTED
// builders: raw Convex builders (query / mutation / action from
// `_generated/server`) silently IGNORE a `permission` / `tenant` / `resource`
// guard option, so using one with a raw builder is flagged. Raw builders are
// otherwise allowed - they are the sanctioned way to define unauthenticated,
// unguarded functions.
//
// Dynamic (non-literal) permission and resource values are skipped: the checker
// cannot resolve them statically, and the runtime engine validates them.

export type IamCheckFinding = {
  code:
    | "convex_dir_missing"
    | "undeclared_permission"
    | "undeclared_resource_type"
    | "guard_on_raw_builder";
  severity: "error";
  filePath: string;
  line: number;
  column: number;
  message: string;
  suggestion?: string;
};

export type IamCheckResult = {
  ok: boolean;
  convexDir: string;
  filesChecked: number;
  findings: IamCheckFinding[];
};

export type CheckIamSourceOptions = {
  cwd?: string;
  convexDir?: string;
};

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirectories = new Set(["_generated", "node_modules", "dist", "build", ".git"]);

export function checkIamSource(options: CheckIamSourceOptions = {}): IamCheckResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const convexDir = resolve(cwd, options.convexDir ?? "convex");

  if (!existsSync(convexDir) || !statSync(convexDir).isDirectory()) {
    const displayPath = displayPathFor(cwd, convexDir);
    return {
      ok: false,
      convexDir,
      filesChecked: 0,
      findings: [
        {
          code: "convex_dir_missing",
          severity: "error",
          filePath: displayPath,
          line: 1,
          column: 1,
          message: `Convex directory not found: ${displayPath}`,
          suggestion: "Run this command from the app root or pass the Convex directory path.",
        },
      ],
    };
  }

  const sourceFiles = collectSourceFiles(convexDir);

  // No catalog (missing or unparseable) means there is nothing to validate
  // against, so the check passes. The real compiler reports catalog problems.
  const catalog = loadIamCatalog(cwd);
  if (!catalog) {
    return { ok: true, convexDir, filesChecked: sourceFiles.length, findings: [] };
  }

  const findings = sourceFiles.flatMap((filePath) => checkSourceFile(cwd, filePath, catalog));
  return {
    ok: findings.length === 0,
    convexDir,
    filesChecked: sourceFiles.length,
    findings,
  };
}

export function formatIamCheckResult(result: IamCheckResult): string {
  if (result.ok) {
    const fileLabel = result.filesChecked === 1 ? "file" : "files";
    return `Hercules IAM static check passed (${result.filesChecked} ${fileLabel} checked). This static check only verifies permission and resource-type keys against .hercules/iam.jsonc; it does not prove runtime access decisions are authorized.`;
  }

  const lines = [`Hercules IAM check failed with ${result.findings.length} finding(s):`];
  for (const finding of result.findings) {
    lines.push(`- ${finding.filePath}:${finding.line}:${finding.column} ${finding.message}`);
    if (finding.suggestion) {
      lines.push(`  ${finding.suggestion}`);
    }
  }
  return lines.join("\n");
}

// --- catalog --------------------------------------------------------------

type IamCatalog = {
  // Declared app permission keys (app.<type>:<action>), or null when the file
  // has no parseable `permissions` section (then the permission check is off).
  permissionKeys: Set<string> | null;
  // Declared app resource-type keys (app.<type>), or null when there is no
  // parseable `resourceTypes` section (then the resource-type check is off).
  resourceTypeKeys: Set<string> | null;
};

// The catalog lives at .hercules/iam.jsonc at the app root and uses the same
// schema the @herculesai/iam compiler reads: `permissions` (app.<type>:<action>
// keys), `resourceTypes` (app.<type> keys), `roles`, and `rolePermissions`.
// This checker only needs the declared permission and resource-type keys.
function loadIamCatalog(cwd: string): IamCatalog | null {
  const iamFilePath = join(cwd, ".hercules", "iam.jsonc");
  if (!existsSync(iamFilePath) || !statSync(iamFilePath).isFile()) {
    return null;
  }

  // parseConfigFileTextToJson parses JSONC (comments, trailing commas), which
  // matches how the build applies the catalog file.
  const parsed = ts.parseConfigFileTextToJson(iamFilePath, readFileSync(iamFilePath, "utf8"));
  if (parsed.error) {
    return null;
  }
  const config = parsed.config as unknown;
  if (!isPlainObject(config)) {
    return null;
  }

  return {
    permissionKeys: isPlainObject(config.permissions)
      ? new Set(Object.keys(config.permissions))
      : null,
    resourceTypeKeys: isPlainObject(config.resourceTypes)
      ? new Set(Object.keys(config.resourceTypes))
      : null,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- source scan ----------------------------------------------------------

function checkSourceFile(cwd: string, filePath: string, catalog: IamCatalog): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const findings: IamCheckFinding[] = [];

  const validatePermission = (literal: { value: string; node: ts.Node }): void => {
    if (catalog.permissionKeys === null) return;
    if (catalog.permissionKeys.has(literal.value)) return;
    findings.push(
      finding(cwd, sourceFile, literal.node, {
        code: "undeclared_permission",
        message: `Permission "${literal.value}" is not declared in .hercules/iam.jsonc.`,
        suggestion:
          'Declare it under "permissions" as an app.<type>:<action> key, or fix it to match a declared permission.',
      }),
    );
  };

  const validateResourceType = (literal: { value: string; node: ts.Node }): void => {
    if (catalog.resourceTypeKeys === null) return;
    // Only app-namespaced resource types are declarable in the catalog; skip
    // anything else (it cannot be checked against `resourceTypes`).
    if (!literal.value.startsWith("app.")) return;
    if (catalog.resourceTypeKeys.has(literal.value)) return;
    findings.push(
      finding(cwd, sourceFile, literal.node, {
        code: "undeclared_resource_type",
        message: `Resource type "${literal.value}" is not declared in .hercules/iam.jsonc.`,
        suggestion:
          'Declare it under "resourceTypes", or fix the type to match a declared resource type.',
      }),
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      // Builder definition: { permission, ..., handler }. `permission` is a
      // single key or an { anyOf } / { allOf } set.
      if (hasProperty(node, "handler")) {
        for (const literal of getPermissionLiterals(node, "permission")) {
          validatePermission(literal);
        }
      }
      // Resource ref / selector: any { type: "app.x", ... } object. These are
      // the `resource` option, nested `parent` refs, and the resource.write /
      // resource.get / resource.list arguments - including a type-ONLY selector
      // such as resource.list(ctx, { type: "app.x" }), which carries no
      // externalId, parent, or permission. We validate the `type` literal
      // unconditionally; the app.-prefix filter in validateResourceType guards
      // against false positives. Builder definitions carry no `type`, so their
      // `permission` (handled above) is not double-reported here.
      const type = getStringProperty(node, "type");
      if (type) {
        validateResourceType(type);
        // resource.get / resource.list may filter by a permission, which is a
        // permission reference too.
        for (const literal of getPermissionLiterals(node, "permission")) {
          validatePermission(literal);
        }
      }
    } else if (ts.isCallExpression(node)) {
      // access.hasPermissions(ctx, perm, ...) / access.requirePermissions(ctx,
      // perm, ...), including the destructured bare forms. `perm` is a single
      // key, a bare array, or an { anyOf } / { allOf } set.
      if (isAccessCheckCall(node)) {
        const permissionArg = node.arguments[1];
        if (permissionArg) {
          for (const literal of collectPermissionLiterals(permissionArg)) {
            validatePermission(literal);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  findings.push(...checkGuardedRawBuilders(cwd, sourceFile));
  return findings;
}

// A call to the in-handler checks: `access.hasPermissions` /
// `access.requirePermissions` (member access on the wired `access` object) or
// the destructured bare `hasPermissions` / `requirePermissions` identifiers.
const ACCESS_CHECK_NAMES: ReadonlySet<string> = new Set(["hasPermissions", "requirePermissions"]);

function isAccessCheckCall(node: ts.CallExpression): boolean {
  const callee = unwrapExpression(node.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    return ACCESS_CHECK_NAMES.has(callee.name.text) && isAccessReceiver(callee.expression);
  }
  if (ts.isIdentifier(callee)) {
    return ACCESS_CHECK_NAMES.has(callee.text);
  }
  return false;
}

function isAccessReceiver(expression: ts.Expression): boolean {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return target.text === "access";
  if (ts.isPropertyAccessExpression(target)) return target.name.text === "access";
  return false;
}

// The raw Convex builder names. Raw builders ignore the access guard options, so
// using one WITH a `permission` / `tenant` / `resource` guard is a bug: the
// guard silently does nothing. App code should define such functions with the
// PROTECTED builders instead. (Importing raw builders is otherwise fine - they
// are how unauthenticated, unguarded functions are defined.)
const RAW_BUILDER_IMPORTS: ReadonlySet<string> = new Set(["query", "mutation", "action"]);
const GUARD_OPTIONS: readonly string[] = ["permission", "tenant", "resource"];

function checkGuardedRawBuilders(cwd: string, sourceFile: ts.SourceFile): IamCheckFinding[] {
  // Local names bound to a raw builder imported from _generated/server
  // (honoring aliases like `import { query as q }`).
  const rawBuilderLocals = collectRawBuilderLocalNames(sourceFile);
  if (rawBuilderLocals.size === 0) return [];

  const findings: IamCheckFinding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee) && rawBuilderLocals.has(callee.text)) {
        const firstArg = node.arguments[0];
        const definition = firstArg ? unwrapExpression(firstArg) : undefined;
        if (
          definition &&
          ts.isObjectLiteralExpression(definition) &&
          hasProperty(definition, "handler")
        ) {
          const guardOption = GUARD_OPTIONS.find((option) => hasProperty(definition, option));
          if (guardOption) {
            findings.push(
              finding(cwd, sourceFile, callee, {
                code: "guard_on_raw_builder",
                message: `Raw Convex builder "${callee.text}" is used with a "${guardOption}" guard option, which it ignores.`,
                suggestion:
                  "Define permission-guarded functions with protectedQuery/protectedMutation/protectedAction (which enforce the guard). Raw query/mutation/action are only for unauthenticated, unguarded functions.",
              }),
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function collectRawBuilderLocalNames(sourceFile: ts.SourceFile): Set<string> {
  const locals = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (!ts.isStringLiteralLike(moduleSpecifier)) continue;
    if (!moduleSpecifier.text.split("\\").join("/").endsWith("_generated/server")) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      // propertyName is the original import name when aliased (`query as q`).
      const importedName = (element.propertyName ?? element.name).text;
      if (RAW_BUILDER_IMPORTS.has(importedName)) locals.add(element.name.text);
    }
  }
  return locals;
}

function hasProperty(object: ts.ObjectLiteralExpression, propertyName: string): boolean {
  return object.properties.some((property) => {
    const name = property.name;
    return (
      name !== undefined &&
      (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
      name.text === propertyName
    );
  });
}

function getStringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): { value: string; node: ts.Node } | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const nameText = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
    if (nameText !== propertyName) continue;
    const initializer = unwrapExpression(property.initializer);
    if (ts.isStringLiteralLike(initializer)) {
      return { value: initializer.text, node: initializer };
    }
  }
  return null;
}

// Extracts every permission string literal from a `permission` property: the
// single-key form, a bare array (allOf), plus each literal inside an
// { anyOf: [...] } / { allOf: [...] } set. Dynamic (non-literal) entries are
// skipped.
function getPermissionLiterals(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): { value: string; node: ts.Node }[] {
  const initializer = getPropertyInitializer(object, propertyName);
  return initializer ? collectPermissionLiterals(initializer) : [];
}

function collectPermissionLiterals(expression: ts.Expression): { value: string; node: ts.Node }[] {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteralLike(node)) {
    return [{ value: node.text, node }];
  }
  if (ts.isArrayLiteralExpression(node)) {
    // A bare array is an allOf shorthand: validate every string literal.
    const literals: { value: string; node: ts.Node }[] = [];
    for (const element of node.elements) {
      const unwrapped = unwrapExpression(element);
      if (ts.isStringLiteralLike(unwrapped)) {
        literals.push({ value: unwrapped.text, node: unwrapped });
      }
    }
    return literals;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const literals: { value: string; node: ts.Node }[] = [];
    for (const setKey of ["anyOf", "allOf"] as const) {
      const initializer = getPropertyInitializer(node, setKey);
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        for (const element of initializer.elements) {
          const unwrapped = unwrapExpression(element);
          if (ts.isStringLiteralLike(unwrapped)) {
            literals.push({ value: unwrapped.text, node: unwrapped });
          }
        }
      }
    }
    return literals;
  }
  return [];
}

function getPropertyInitializer(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const nameText = ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
    if (nameText === propertyName) {
      return unwrapExpression(property.initializer);
    }
  }
  return null;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

// --- files + formatting helpers -------------------------------------------

function collectSourceFiles(directory: string): string[] {
  const sourceFiles: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        sourceFiles.push(...collectSourceFiles(entryPath));
      }
      continue;
    }
    if (sourceExtensions.has(extensionOf(entry.name))) {
      sourceFiles.push(entryPath);
    }
  }
  return sourceFiles.sort((left, right) => left.localeCompare(right));
}

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex);
}

function finding(
  cwd: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  details: { code: IamCheckFinding["code"]; message: string; suggestion?: string },
): IamCheckFinding {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    code: details.code,
    severity: "error",
    filePath: displayPathFor(cwd, sourceFile.fileName),
    line: line + 1,
    column: character + 1,
    message: details.message,
    ...(details.suggestion === undefined ? {} : { suggestion: details.suggestion }),
  };
}

function displayPathFor(cwd: string, filePath: string): string {
  const relativePath = relative(cwd, filePath);
  if (relativePath === "" || relativePath.startsWith("..")) {
    return filePath;
  }
  return relativePath.split("\\").join("/");
}
