import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";

// ---------------------------------------------------------------------------
// Build-time IAM static checker for @usehercules/convex apps.
// ---------------------------------------------------------------------------
//
// Validates an app's Convex source against its hercules/iam.jsonc catalog so a
// permission or resource-type typo fails the build instead of failing at
// runtime. It is deliberately small and membership-only: it does not model the
// runtime ReBAC engine, it only checks that the permission and resource-type
// STRING LITERALS the code references are declared in the catalog.
//
// What it scans in the new createIam surface:
//   - The `permission` option on the auth-aware builders
//     query/mutation/action (any builder definition object with a handler).
//   - The permission argument to iam.can(ctx, "app.x:y", ...) and
//     iam.require(ctx, "app.x:y", ...).
//   - Resource-type literals in resource refs: the `resource` option, the args
//     to resource.write / resource.get / resource.list, and nested `parent`
//     refs (any { type: "app.x", externalId | parent }).
//
// Dynamic (non-literal) permission and resource values are skipped: the checker
// cannot resolve them statically, and the runtime engine validates them.

export type IamCheckFinding = {
  code: "convex_dir_missing" | "undeclared_permission" | "undeclared_resource_type";
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

// The complete set of platform (`system.*`) permission keys Hercules seeds for
// every app. They are provided by the platform and never declared in an app's
// iam.jsonc, so the checker accepts exactly these and reports any other
// `system.*` literal as an undeclared permission. Matching by an exact set
// (rather than by grammar) catches typos like `system.access.tenants:raed`,
// which would otherwise pass the build and only fail at runtime.
//
// This list MUST mirror backend-shared SEEDED_SYSTEM_PERMISSION_CATALOG.
const SEEDED_SYSTEM_PERMISSIONS = new Set<string>([
  "system.access.tenants:manage",
  "system.access.impersonation:manage",
  "system.access.users:read",
  "system.access.users:manage",
  "system.access.groups:read",
  "system.access.groups:manage",
  "system.access.roles:read",
  "system.access.assignments:manage",
  "system.access.invitations:manage",
  "system.access.invitations:read",
  "system.access.admission:manage",
  "system.access.admission:read",
  "system.access.audit:read",
]);

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
    return `Hercules IAM static check passed (${result.filesChecked} ${fileLabel} checked). This static check only verifies permission and resource-type keys against hercules/iam.jsonc; it does not prove runtime access decisions are authorized.`;
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

// The catalog lives at hercules/iam.jsonc at the app root and uses the same
// schema the @herculesai/iam compiler reads: `permissions` (app.<type>:<action>
// keys), `resourceTypes` (app.<type> keys), `roles`, and `rolePermissions`.
// This checker only needs the declared permission and resource-type keys.
function loadIamCatalog(cwd: string): IamCatalog | null {
  const iamFilePath = join(cwd, "hercules", "iam.jsonc");
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
    if (SEEDED_SYSTEM_PERMISSIONS.has(literal.value)) return;
    findings.push(
      finding(cwd, sourceFile, literal.node, {
        code: "undeclared_permission",
        message: `Permission "${literal.value}" is not declared in hercules/iam.jsonc.`,
        suggestion:
          'Declare it under "permissions" as an app.<type>:<action> key, or reference an existing catalog or system.* permission.',
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
        message: `Resource type "${literal.value}" is not declared in hercules/iam.jsonc.`,
        suggestion:
          'Declare it under "resourceTypes", or fix the type to match a declared resource type.',
      }),
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      // Builder definition: { permission: "app.x:y", ..., handler }.
      if (hasProperty(node, "handler")) {
        const permission = getStringProperty(node, "permission");
        if (permission) validatePermission(permission);
      }
      // Resource ref / selector: any { type: "app.x", ... } object. These are
      // the `resource` option, nested `parent` refs, and the resource.write /
      // resource.get / resource.list arguments — including a type-ONLY selector
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
        const permission = getStringProperty(node, "permission");
        if (permission) validatePermission(permission);
      }
    } else if (ts.isCallExpression(node)) {
      // iam.can(ctx, "app.x:y", ...) / iam.require(ctx, "app.x:y", ...).
      const callee = unwrapExpression(node.expression);
      if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === "can" || callee.name.text === "require") &&
        isIamReceiver(callee.expression)
      ) {
        const permissionArg = node.arguments[1] && unwrapExpression(node.arguments[1]);
        if (permissionArg && ts.isStringLiteralLike(permissionArg)) {
          validatePermission({ value: permissionArg.text, node: permissionArg });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return findings;
}

// The object before `.can` / `.require` is the destructured `iam` helper (or a
// member access ending in `iam`, e.g. `hercules.iam`).
function isIamReceiver(expression: ts.Expression): boolean {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) return target.text === "iam";
  if (ts.isPropertyAccessExpression(target)) return target.name.text === "iam";
  return false;
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
