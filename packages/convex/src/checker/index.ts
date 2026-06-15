import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";

type RawConvexBuilder = "query" | "mutation" | "action";

type RawBuilderCandidate = {
  builder: RawConvexBuilder;
  builderNode: ts.Identifier;
  functionName: string;
  isDirectExport: boolean;
  declaration: ts.Node;
};

export type AccessControlCheckFinding = {
  code:
    | "convex_dir_missing"
    | "raw_exported_convex_builder"
    | "placeholder_access_scope_id"
    | "hardcoded_access_scope_id"
    | "local_org_membership_table"
    | "optional_org_scope_id"
    | "org_scoped_global_slug_lookup"
    | "org_row_scope_from_arg"
    | "authenticated_org_data_read"
    | "privileged_resource_permission_rule"
    | "public_service_authority_call"
    | "noncanonical_permission_key";
  severity: "error";
  filePath: string;
  line: number;
  column: number;
  functionName?: string;
  builder?: RawConvexBuilder;
  message: string;
  suggestion?: string;
};

export type AccessControlCheckResult = {
  ok: boolean;
  convexDir: string;
  filesChecked: number;
  fixedFiles: number;
  findings: AccessControlCheckFinding[];
};

export type CheckAccessControlSourceOptions = {
  cwd?: string;
  convexDir?: string;
  fixAuthenticated?: boolean;
};

const rawBuilderNames = new Set<string>(["query", "mutation", "action"]);
const publicBuilderNames = new Set<string>([
  "publicQuery",
  "publicMutation",
  "publicAction",
  "authenticatedQuery",
  "authenticatedMutation",
  "authenticatedAction",
  "accessQuery",
  "accessMutation",
  "accessAction",
]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirectories = new Set(["_generated", "node_modules", "dist", ".git"]);
const exemptFileNames = new Set([
  "access.ts",
  "access.tsx",
  "hercules.ts",
  "hercules.tsx",
  "http.ts",
  "convex.config.ts",
]);
const exemptionMarkers = [
  "hercules-access-control: allow-raw-builder",
  "hercules-access-control: allow-raw-builders",
];
const accessControlPackageName = "@usehercules/convex";

export function checkAccessControlSource(
  options: CheckAccessControlSourceOptions = {},
): AccessControlCheckResult {
  const cwd = resolve(options.cwd ?? process.cwd());
  const convexDir = resolve(cwd, options.convexDir ?? "convex");

  if (!existsSync(convexDir) || !statSync(convexDir).isDirectory()) {
    const displayPath = displayPathFor(cwd, convexDir);
    return {
      ok: false,
      convexDir,
      filesChecked: 0,
      fixedFiles: 0,
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

  // The managed-pattern rules only apply to apps that actually wire managed
  // Access Control into their Convex functions. A plain Convex app keeps raw
  // builder behavior, so the whole check is a pass-through no-op for it.
  const markerFiles = collectSourceFiles(convexDir, {
    includeExemptFiles: true,
  });
  if (!markerFiles.some((filePath) => fileUsesManagedAccessControl(filePath, convexDir))) {
    return {
      ok: true,
      convexDir,
      filesChecked: markerFiles.length,
      fixedFiles: 0,
      findings: [],
    };
  }

  const sourceFiles = collectSourceFiles(convexDir);
  const appSourceFiles = collectAppSourceFiles(cwd, convexDir);
  const orgOwnedTables = collectOrgOwnedTables(sourceFiles);
  const catalogPermissionKeys = loadCatalogPermissionKeys(cwd);
  const fixedFiles = options.fixAuthenticated
    ? sourceFiles.filter((filePath) => fixSourceFileToAuthenticatedBuilders(filePath, convexDir))
        .length
    : 0;
  const findings = [
    ...sourceFiles.flatMap((filePath) => checkSourceFile(cwd, filePath)),
    ...markerFiles.flatMap((filePath) => checkPublicServiceAuthorityCalls(cwd, filePath)),
    ...markerFiles.flatMap((filePath) => checkHardcodedAccessScopeIds(cwd, filePath)),
    ...markerFiles.flatMap((filePath) => checkPrivilegedResourcePermissionRules(cwd, filePath)),
    ...sourceFiles.flatMap((filePath) =>
      checkCanonicalPermissionKeys(cwd, filePath, catalogPermissionKeys),
    ),
    ...[...sourceFiles, ...appSourceFiles].flatMap((filePath) =>
      checkAccessControlOrgPatterns(cwd, filePath, orgOwnedTables),
    ),
  ];

  return {
    ok: findings.length === 0,
    convexDir,
    filesChecked: sourceFiles.length + appSourceFiles.length,
    fixedFiles,
    findings,
  };
}

export function formatAccessControlCheckResult(result: AccessControlCheckResult): string {
  if (result.ok) {
    const fileLabel = result.filesChecked === 1 ? "file" : "files";
    const fixedLabel =
      result.fixedFiles > 0
        ? ` ${result.fixedFiles} ${result.fixedFiles === 1 ? "file was" : "files were"} updated.`
        : "";
    return `Hercules Access Control static check passed (${result.filesChecked} ${fileLabel} checked).${fixedLabel} This static check does not prove runtime role decisions or control-plane writes are authorized.`;
  }

  const lines = [`Hercules Access Control check failed with ${result.findings.length} finding(s):`];

  for (const finding of result.findings) {
    lines.push(`- ${finding.filePath}:${finding.line}:${finding.column} ${finding.message}`);
    if (finding.suggestion) {
      lines.push(`  ${finding.suggestion}`);
    }
  }

  return lines.join("\n");
}

function fixSourceFileToAuthenticatedBuilders(filePath: string, convexDir: string): boolean {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const rawBuilderImports = collectRawBuilderImports(sourceFile);
  if (rawBuilderImports.size === 0) {
    return false;
  }

  const exportedNames = collectExportedNames(sourceFile);
  const candidates = collectRawBuilderCandidates(sourceFile, rawBuilderImports)
    .filter((candidate) => candidate.isDirectExport || exportedNames.has(candidate.functionName))
    .filter((candidate) => !hasLocalExemption(sourceFile, sourceText, candidate.declaration));
  if (candidates.length === 0) {
    return false;
  }

  const replacements = candidates.map((candidate) => ({
    start: candidate.builderNode.getStart(sourceFile),
    end: candidate.builderNode.getEnd(),
    text: authenticatedBuilderName(candidate.builder),
  }));
  const accessImports = new Set(replacements.map((replacement) => replacement.text));
  replacements.push(...buildGeneratedServerImportRemovals(sourceFile, sourceText, candidates));
  replacements.push(buildAccessImportReplacement(sourceFile, sourceText, accessImports, convexDir));

  const nextSourceText = applyTextReplacements(sourceText, replacements);
  if (nextSourceText === sourceText) {
    return false;
  }

  writeFileSync(filePath, nextSourceText);
  return true;
}

function collectSourceFiles(
  directory: string,
  options: { includeExemptFiles?: boolean } = {},
): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const sourceFiles: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        sourceFiles.push(...collectSourceFiles(entryPath, options));
      }
      continue;
    }

    if (
      isSourceFile(entryPath) &&
      (options.includeExemptFiles || !exemptFileNames.has(basename(entryPath)))
    ) {
      sourceFiles.push(entryPath);
    }
  }

  return sourceFiles.sort((left, right) => left.localeCompare(right));
}

function collectAppSourceFiles(cwd: string, convexDir: string): string[] {
  const srcDir = resolve(cwd, "src");
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return [];
  if (srcDir === convexDir) return [];
  return collectSourceFiles(srcDir);
}

function checkSourceFile(cwd: string, filePath: string): AccessControlCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const rawBuilderImports = collectRawBuilderImports(sourceFile);
  if (rawBuilderImports.size === 0) {
    return [];
  }

  const exportedNames = collectExportedNames(sourceFile);
  const candidates = collectRawBuilderCandidates(sourceFile, rawBuilderImports);
  return candidates
    .filter((candidate) => candidate.isDirectExport || exportedNames.has(candidate.functionName))
    .filter((candidate) => !hasLocalExemption(sourceFile, sourceText, candidate.declaration))
    .map((candidate) => createFinding(cwd, sourceFile, candidate));
}

function checkAccessControlOrgPatterns(
  cwd: string,
  filePath: string,
  orgOwnedTables: Set<string>,
): AccessControlCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: AccessControlCheckFinding[] = [];

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "placeholder_access_scope_id",
    pattern: /\b(?:herculesScopeId|accessScopeId|orgScopeId)\s*:\s*["']{2}/,
    message:
      "Do not store a blank Hercules Access Control scope id. Create a Hercules Access Control scope first, then persist the returned accessScopeId.",
    suggestion:
      "Use createAccessScope from @usehercules/convex/access-admin before inserting org metadata.",
  });

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "local_org_membership_table",
    pattern: /\b(?:memberships|membership|orgMembers|organizationMembers)\s*:\s*defineTable\b/,
    message: "Managed Access Control apps should not define app-local org membership tables.",
    suggestion:
      "Use Hercules Access Control scopes, principals, and role grants. Store only org metadata in app tables.",
  });

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "optional_org_scope_id",
    pattern: /\borgScopeId\s*:\s*v\.optional\s*\(\s*v\.string\s*\(\s*\)\s*\)/,
    message: "Org-owned rows should require orgScopeId.",
    suggestion:
      "Backfill existing rows during conversion, then store orgScopeId as v.string() on org-owned tables.",
  });

  if (/\borgScopeId\b/.test(sourceText) && /\.withIndex\s*\(\s*["']by_slug["']/.test(sourceText)) {
    addPatternFinding({
      findings,
      cwd,
      filePath,
      sourceText,
      code: "org_scoped_global_slug_lookup",
      pattern: /\.withIndex\s*\(\s*["']by_slug["']/,
      message: "Org-scoped slug lookups must include the org scope id in the index.",
      suggestion:
        'Use an index such as by_org_and_slug on ["orgScopeId", "slug"] and query both values together.',
    });
  }

  for (const definition of collectManagedBuilderDefinitions(sourceFile, [
    "accessQuery",
    "accessMutation",
    "accessAction",
  ])) {
    if (
      /\bscopeFromArg\s*\(\s*["']orgScopeId["']\s*\)/.test(definition.text) &&
      /\bctx\.db\.(?:get|patch|replace|delete)\s*\(\s*args\.[A-Za-z_$][\w$]*/.test(definition.text)
    ) {
      findings.push(
        createPatternFindingAtNode({
          cwd,
          sourceFile,
          node: definition.node,
          code: "org_row_scope_from_arg",
          message:
            "Operations on an org-owned row id must authorize against the stored row scope, not a caller supplied scope id.",
          suggestion:
            'Use scopeFromResource("tableName", "rowIdArg") for row read, update, publish, moderation, and delete operations.',
        }),
      );
    }
  }

  for (const definition of collectManagedBuilderDefinitions(sourceFile, ["authenticatedQuery"])) {
    const readsOrgOwnedTable = [...orgOwnedTables].some((tableName) => {
      const escapedName = escapeRegExp(tableName);
      return (
        new RegExp(`\\.query\\s*\\(\\s*["']${escapedName}["']`).test(definition.text) ||
        (new RegExp(`v\\.id\\s*\\(\\s*["']${escapedName}["']`).test(definition.text) &&
          /\bctx\.db\.get\s*\(\s*args\.[A-Za-z_$][\w$]*/.test(definition.text))
      );
    });
    if (readsOrgOwnedTable) {
      findings.push(
        createPatternFindingAtNode({
          cwd,
          sourceFile,
          node: definition.node,
          code: "authenticated_org_data_read",
          message: "Authenticated reads of org-owned data do not prove organization membership.",
          suggestion:
            "Use accessQuery for private organization data. Use publicQuery only for explicitly public rows filtered to public state.",
        }),
      );
    }
  }

  return findings;
}

function collectOrgOwnedTables(sourceFiles: string[]): Set<string> {
  const tableNames = new Set<string>();
  for (const filePath of sourceFiles) {
    if (!/^schema\.(?:ts|tsx|js|jsx)$/.test(basename(filePath))) continue;

    const sourceText = readFileSync(filePath, "utf8");
    const tablePattern = /\b([A-Za-z_$][\w$]*)\s*:\s*defineTable\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    for (const match of sourceText.matchAll(tablePattern)) {
      if (/\borgScopeId\s*:/.test(match[2] ?? "")) {
        tableNames.add(match[1]!);
      }
    }
  }
  return tableNames;
}

function collectManagedBuilderDefinitions(
  sourceFile: ts.SourceFile,
  builderNames: string[],
): Array<{ node: ts.Node; text: string; definition: ts.Expression }> {
  const acceptedNames = new Set(builderNames);
  const definitions: Array<{
    node: ts.Node;
    text: string;
    definition: ts.Expression;
  }> = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const target = unwrapExpression(node.expression);
      const definition = node.arguments[0];
      if (ts.isIdentifier(target) && acceptedNames.has(target.text) && definition) {
        definitions.push({
          node,
          text: definition.getText(sourceFile),
          definition,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return definitions;
}

function checkHardcodedAccessScopeIds(
  cwd: string,
  filePath: string,
): AccessControlCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const findings: AccessControlCheckFinding[] = [];

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "hardcoded_access_scope_id",
    pattern:
      /\b(?:[A-Z][A-Z0-9_]*_)?(?:ACCESS_)?SCOPE_ID\b\s*=\s*["']01[A-Z0-9]{24}["']|\bscopeId\s*:\s*["']01[A-Z0-9]{24}["']/,
    message: "Do not hardcode Access Control scope ids.",
    suggestion:
      'Use the "default" scope sentinel for the app scope, or store org scope ids returned by createAccessScope/createOrgScope on app rows and load them from the row.',
  });

  return findings;
}

function checkPrivilegedResourcePermissionRules(
  cwd: string,
  filePath: string,
): AccessControlCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: AccessControlCheckFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const permission = getStringProperty(node, "permissionKey");
      const effect = getStringProperty(node, "effect");
      if (permission && effect?.value === "allow" && isPrivilegedResourceRuleKey(permission.value)) {
        findings.push(
          createPatternFindingAtNode({
            cwd,
            sourceFile,
            node: permission.node,
            code: "privileged_resource_permission_rule",
            message:
              "Do not grant manage_members, manage_access, system.*, or wildcard permissions through resource permission rules.",
            suggestion:
              "Use resource role grants for scoped management authority. Resource permission rules are for ordinary allow/deny exceptions.",
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function checkPublicServiceAuthorityCalls(cwd: string, filePath: string): AccessControlCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  if (!hasExportedPublicBuilder(sourceFile)) {
    return [];
  }

  const internalApiNames = collectInternalApiNames(sourceFile);
  if (internalApiNames.size === 0) {
    return [];
  }

  const findings: AccessControlCheckFinding[] = [];

  function visit(node: ts.Node): void {
    if (isAccessAdminReference(node, internalApiNames)) {
      findings.push(
        createPatternFindingAtNode({
          cwd,
          sourceFile,
          node,
          code: "public_service_authority_call",
          message:
            "Exported public Convex functions must not reference internal.accessAdmin service-authority actions.",
          suggestion: "Use app-user actions for public access changes, or keep the service-authority caller internal.",
        }),
      );
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function hasExportedPublicBuilder(sourceFile: ts.SourceFile): boolean {
  const exportedNames = collectExportedNames(sourceFile);
  const builderNames = collectPublicBuilderNames(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isDirectExport = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (isDirectExport || exportedNames.has(declaration.name.text)) &&
          isPublicBuilderCall(declaration.initializer, builderNames)
        ) {
          return true;
        }
      }
    }

    if (ts.isExportAssignment(statement) && isPublicBuilderCall(statement.expression, builderNames)) {
      return true;
    }
  }

  return false;
}

function collectPublicBuilderNames(sourceFile: ts.SourceFile): Set<string> {
  const builderNames = new Set(publicBuilderNames);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const importSpecifier of namedBindings.elements) {
      const importedName = (importSpecifier.propertyName ?? importSpecifier.name).text;
      if (publicBuilderNames.has(importedName)) {
        builderNames.add(importSpecifier.name.text);
      }
    }
  }

  return builderNames;
}

function isPublicBuilderCall(initializer: ts.Expression, builderNames: Set<string>): boolean {
  const expression = unwrapExpression(initializer);
  if (!ts.isCallExpression(expression)) {
    return false;
  }

  const target = unwrapExpression(expression.expression);
  return ts.isIdentifier(target) && builderNames.has(target.text);
}

function collectInternalApiNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier) || !isGeneratedApiImport(statement.moduleSpecifier.text)) {
      continue;
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const importSpecifier of namedBindings.elements) {
      const importedName = (importSpecifier.propertyName ?? importSpecifier.name).text;
      if (importedName === "internal") {
        names.add(importSpecifier.name.text);
      }
    }
  }

  return names;
}

function isAccessAdminReference(node: ts.Node, internalApiNames: Set<string>): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    const target = unwrapExpression(node.expression);
    return ts.isIdentifier(target) && internalApiNames.has(target.text) && node.name.text === "accessAdmin";
  }

  if (ts.isElementAccessExpression(node)) {
    const target = unwrapExpression(node.expression);
    const argument = node.argumentExpression && unwrapExpression(node.argumentExpression);
    return (
      ts.isIdentifier(target) &&
      internalApiNames.has(target.text) &&
      !!argument &&
      ts.isStringLiteralLike(argument) &&
      argument.text === "accessAdmin"
    );
  }

  return false;
}

function getStringProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): { value: string; node: ts.Node } | null {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const nameText = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (nameText !== propertyName) continue;
    const value = unwrapExpression(property.initializer);
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return { value: value.text, node: value };
    }
  }
  return null;
}

function isPrivilegedResourceRuleKey(permissionKey: string): boolean {
  if (permissionKey.startsWith("system.")) return true;
  if (!permissionKey.startsWith("app.")) return false;
  const actionSeparatorIndex = permissionKey.lastIndexOf(":");
  const action = actionSeparatorIndex === -1 ? "" : permissionKey.slice(actionSeparatorIndex + 1);
  return action === "*" || action === "manage_members" || action === "manage_access";
}

// The IAM catalog is file-only: hercules/iam.jsonc at the app root declares
// every app permission key, and the control plane seeds the platform
// system.* keys. Returns null when the file is missing or does not parse as
// a permissions catalog, which disables the noncanonical_permission_key
// check instead of risking false positives.
function loadCatalogPermissionKeys(cwd: string): Set<string> | null {
  const iamFilePath = join(cwd, "hercules", "iam.jsonc");
  if (!existsSync(iamFilePath) || !statSync(iamFilePath).isFile()) {
    return null;
  }

  // parseConfigFileTextToJson parses JSONC (comments and trailing commas),
  // matching how the build applies the catalog file.
  const parsed = ts.parseConfigFileTextToJson(iamFilePath, readFileSync(iamFilePath, "utf8"));
  if (parsed.error) {
    return null;
  }
  const permissions = (parsed.config as { permissions?: unknown } | undefined)?.permissions;
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return null;
  }
  return new Set(Object.keys(permissions));
}

// The runtime authorize gate resolves a requested permission by exact key
// lookup in the catalog and denies a miss with permission_missing, so a
// builder-level permission literal that is not a declared catalog key always
// fails at runtime. Membership only: no key grammar is parsed, dynamic
// permission values are skipped, and system.* keys are platform-seeded.
function checkCanonicalPermissionKeys(
  cwd: string,
  filePath: string,
  catalogPermissionKeys: Set<string> | null,
): AccessControlCheckFinding[] {
  if (!catalogPermissionKeys) {
    return [];
  }

  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: AccessControlCheckFinding[] = [];

  for (const definition of collectManagedBuilderDefinitions(sourceFile, [
    "accessQuery",
    "accessMutation",
    "accessAction",
  ])) {
    const permission = getLiteralPermissionProperty(definition.definition);
    if (!permission) continue;
    if (catalogPermissionKeys.has(permission.key) || permission.key.startsWith("system.")) {
      continue;
    }

    const prefixedKey = `app.${permission.key}`;
    findings.push(
      createPatternFindingAtNode({
        cwd,
        sourceFile,
        node: permission.node,
        code: "noncanonical_permission_key",
        message: `Permission key "${permission.key}" is not declared in hercules/iam.jsonc.`,
        suggestion: catalogPermissionKeys.has(prefixedKey)
          ? `Use the catalog key "${prefixedKey}" exactly as declared in hercules/iam.jsonc.`
          : "Use a permission key exactly as declared in hercules/iam.jsonc, or add it to the catalog and rebuild.",
      }),
    );
  }

  return findings;
}

function getLiteralPermissionProperty(
  definition: ts.Expression,
): { key: string; node: ts.Node } | null {
  const objectLiteral = unwrapExpression(definition);
  if (!ts.isObjectLiteralExpression(objectLiteral)) {
    return null;
  }

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    const nameText = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (nameText !== "permission") continue;

    const initializer = unwrapExpression(property.initializer);
    return ts.isStringLiteralLike(initializer)
      ? { key: initializer.text, node: initializer }
      : null;
  }

  return null;
}

function createPatternFindingAtNode(args: {
  cwd: string;
  sourceFile: ts.SourceFile;
  node: ts.Node;
  code: AccessControlCheckFinding["code"];
  message: string;
  suggestion: string;
}): AccessControlCheckFinding {
  const position = args.sourceFile.getLineAndCharacterOfPosition(
    args.node.getStart(args.sourceFile),
  );
  return {
    code: args.code,
    severity: "error",
    filePath: displayPathFor(args.cwd, args.sourceFile.fileName),
    line: position.line + 1,
    column: position.character + 1,
    message: args.message,
    suggestion: args.suggestion,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addPatternFinding(args: {
  findings: AccessControlCheckFinding[];
  cwd: string;
  filePath: string;
  sourceText: string;
  code: AccessControlCheckFinding["code"];
  pattern: RegExp;
  message: string;
  suggestion: string;
}): void {
  const match = args.pattern.exec(args.sourceText);
  if (!match?.index && match?.index !== 0) return;

  const position = lineAndColumnAt(args.sourceText, match.index);
  args.findings.push({
    code: args.code,
    severity: "error",
    filePath: displayPathFor(args.cwd, args.filePath),
    line: position.line,
    column: position.column,
    message: args.message,
    suggestion: args.suggestion,
  });
}

function lineAndColumnAt(sourceText: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (sourceText[offset] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function createSourceFile(filePath: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function collectRawBuilderImports(sourceFile: ts.SourceFile): Map<string, RawConvexBuilder> {
  const imports = new Map<string, RawConvexBuilder>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isGeneratedServerImport(statement.moduleSpecifier.text)
    ) {
      continue;
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const importSpecifier of namedBindings.elements) {
      const importedName = (importSpecifier.propertyName ?? importSpecifier.name).text;
      if (isRawBuilderName(importedName)) {
        imports.set(importSpecifier.name.text, importedName);
      }
    }
  }

  return imports;
}

function buildGeneratedServerImportRemovals(
  sourceFile: ts.SourceFile,
  sourceText: string,
  candidates: RawBuilderCandidate[],
): Array<{ start: number; end: number; text: string }> {
  const builderNodeStarts = new Set(
    candidates.map((candidate) => candidate.builderNode.getStart(sourceFile)),
  );
  const builderNamesToReplace = new Set(candidates.map((candidate) => candidate.builderNode.text));
  const identifierUses = collectIdentifierUses(sourceFile, builderNamesToReplace);
  const removableNames = new Set<string>();

  for (const name of builderNamesToReplace) {
    const uses = identifierUses.get(name) ?? [];
    if (uses.length > 0 && uses.every((position) => builderNodeStarts.has(position))) {
      removableNames.add(name);
    }
  }

  if (removableNames.size === 0) {
    return [];
  }

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isGeneratedServerImport(statement.moduleSpecifier.text)
    ) {
      continue;
    }

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    const rawSpecifiersToRemove = namedBindings.elements.filter((specifier) =>
      removableNames.has(specifier.name.text),
    );
    if (rawSpecifiersToRemove.length === 0) {
      continue;
    }

    if (rawSpecifiersToRemove.length === namedBindings.elements.length) {
      const start = statement.getFullStart();
      const end = includeTrailingNewline(sourceText, statement.getEnd());
      replacements.push({ start, end, text: "" });
      continue;
    }

    for (const specifier of rawSpecifiersToRemove) {
      replacements.push(buildImportSpecifierRemoval(namedBindings, specifier));
    }
  }

  return replacements;
}

function collectIdentifierUses(
  sourceFile: ts.SourceFile,
  names: Set<string>,
): Map<string, number[]> {
  const uses = new Map<string, number[]>();

  function visit(node: ts.Node) {
    if (ts.isImportSpecifier(node) && names.has(node.name.text)) {
      return;
    }
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const positions = uses.get(node.text) ?? [];
      positions.push(node.getStart(sourceFile));
      uses.set(node.text, positions);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return uses;
}

function buildImportSpecifierRemoval(
  namedImports: ts.NamedImports,
  specifier: ts.ImportSpecifier,
): { start: number; end: number; text: string } {
  const elements = namedImports.elements;
  const index = elements.findIndex((element) => element === specifier);
  if (index === -1) {
    return {
      start: specifier.getFullStart(),
      end: specifier.getEnd(),
      text: "",
    };
  }

  const previous = elements[index - 1];
  const next = elements[index + 1];
  if (next) {
    return {
      start: specifier.getFullStart(),
      end: next.getFullStart(),
      text: "",
    };
  }

  if (previous) {
    return { start: previous.getEnd(), end: specifier.getEnd(), text: "" };
  }

  return { start: specifier.getFullStart(), end: specifier.getEnd(), text: "" };
}

function buildAccessImportReplacement(
  sourceFile: ts.SourceFile,
  sourceText: string,
  accessImports: Set<string>,
  convexDir: string,
): { start: number; end: number; text: string } {
  const sortedImports = [...accessImports].sort();
  const accessImport = findAccessImport(sourceFile, convexDir);

  if (accessImport?.namedBindings && ts.isNamedImports(accessImport.namedBindings)) {
    const existingNames = new Set(
      accessImport.namedBindings.elements.map((specifier) => specifier.name.text),
    );
    const missingNames = sortedImports.filter((name) => !existingNames.has(name));
    if (missingNames.length === 0) {
      return { start: 0, end: 0, text: "" };
    }

    const closingBraceStart = accessImport.namedBindings.getEnd() - 1;
    const prefix = accessImport.namedBindings.elements.length > 0 ? ", " : "";
    return {
      start: closingBraceStart,
      end: closingBraceStart,
      text: `${prefix}${missingNames.join(", ")}`,
    };
  }

  const accessImportPath = buildAccessImportPath(sourceFile, convexDir);
  const importLine = `import { ${sortedImports.join(", ")} } from "${accessImportPath}";\n`;
  const lastImport = sourceFile.statements.filter(ts.isImportDeclaration).at(-1);
  if (!lastImport) {
    return { start: 0, end: 0, text: importLine };
  }

  return {
    start: includeTrailingNewline(sourceText, lastImport.getEnd()),
    end: includeTrailingNewline(sourceText, lastImport.getEnd()),
    text: importLine,
  };
}

function findAccessImport(
  sourceFile: ts.SourceFile,
  convexDir: string,
): { namedBindings?: ts.NamedImportBindings } | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isAccessImport(sourceFile, statement.moduleSpecifier.text, convexDir)
    ) {
      continue;
    }

    return { namedBindings: statement.importClause?.namedBindings };
  }

  return null;
}

function buildAccessImportPath(sourceFile: ts.SourceFile, convexDir: string): string {
  const relativePath = normalizePath(
    relative(dirname(sourceFile.fileName), join(convexDir, "hercules")),
  );
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function isAccessImport(
  sourceFile: ts.SourceFile,
  moduleSpecifier: string,
  convexDir: string,
): boolean {
  if (!moduleSpecifier.startsWith(".")) {
    return false;
  }

  return (
    stripKnownModuleExtension(resolve(dirname(sourceFile.fileName), moduleSpecifier)) ===
      join(convexDir, "hercules") ||
    stripKnownModuleExtension(resolve(dirname(sourceFile.fileName), moduleSpecifier)) ===
      join(convexDir, "access")
  );
}

// A Convex function file uses managed Access Control when it imports the
// @usehercules/convex SDK (including subpaths such as /access-admin and
// /convex.config) or the local convex/hercules or convex/access wiring module
// the managed builders are re-exported from.
function fileUsesManagedAccessControl(filePath: string, convexDir: string): boolean {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      continue;
    }
    if (
      moduleSpecifier.text === accessControlPackageName ||
      moduleSpecifier.text.startsWith(`${accessControlPackageName}/`) ||
      isAccessImport(sourceFile, moduleSpecifier.text, convexDir)
    ) {
      return true;
    }
  }

  return false;
}

function collectExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    const exportClause = statement.exportClause;
    if (!exportClause || !ts.isNamedExports(exportClause)) {
      continue;
    }

    for (const exportSpecifier of exportClause.elements) {
      names.add((exportSpecifier.propertyName ?? exportSpecifier.name).text);
    }
  }

  return names;
}

function collectRawBuilderCandidates(
  sourceFile: ts.SourceFile,
  rawBuilderImports: Map<string, RawConvexBuilder>,
): RawBuilderCandidate[] {
  const candidates: RawBuilderCandidate[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isDirectExport = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }

        const rawCall = getRawBuilderCall(declaration.initializer, rawBuilderImports);
        if (rawCall) {
          candidates.push({
            ...rawCall,
            functionName: declaration.name.text,
            isDirectExport,
            declaration: statement,
          });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      const rawCall = getRawBuilderCall(statement.expression, rawBuilderImports);
      if (rawCall) {
        candidates.push({
          ...rawCall,
          functionName: "default",
          isDirectExport: true,
          declaration: statement,
        });
      }
    }
  }

  return candidates;
}

function getRawBuilderCall(
  initializer: ts.Expression,
  rawBuilderImports: Map<string, RawConvexBuilder>,
): Pick<RawBuilderCandidate, "builder" | "builderNode"> | null {
  const expression = unwrapExpression(initializer);
  if (!ts.isCallExpression(expression)) {
    return null;
  }

  const callTarget = unwrapExpression(expression.expression);
  if (!ts.isIdentifier(callTarget)) {
    return null;
  }

  const builder = rawBuilderImports.get(callTarget.text);
  if (!builder) {
    return null;
  }

  return { builder, builderNode: callTarget };
}

function createFinding(
  cwd: string,
  sourceFile: ts.SourceFile,
  candidate: RawBuilderCandidate,
): AccessControlCheckFinding {
  const position = sourceFile.getLineAndCharacterOfPosition(
    candidate.builderNode.getStart(sourceFile),
  );
  const builderSuffix = builderDisplaySuffix(candidate.builder);

  return {
    code: "raw_exported_convex_builder",
    severity: "error",
    filePath: displayPathFor(cwd, sourceFile.fileName),
    line: position.line + 1,
    column: position.character + 1,
    functionName: candidate.functionName,
    builder: candidate.builder,
    message: `Exported Convex function "${candidate.functionName}" uses raw ${candidate.builder}().`,
    suggestion: `Import from ./hercules and choose public${builderSuffix}, authenticated${builderSuffix}, or access${builderSuffix}.`,
  };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

function hasLocalExemption(
  sourceFile: ts.SourceFile,
  sourceText: string,
  declaration: ts.Node,
): boolean {
  const leadingText = sourceText.slice(
    declaration.getFullStart(),
    declaration.getStart(sourceFile),
  );
  return exemptionMarkers.some((marker) => leadingText.includes(marker));
}

function isSourceFile(filePath: string): boolean {
  return sourceExtensions.has(extname(filePath)) && !filePath.endsWith(".d.ts");
}

function isGeneratedServerImport(moduleSpecifier: string): boolean {
  return (
    moduleSpecifier.endsWith("_generated/server") ||
    moduleSpecifier.endsWith("_generated/server.js")
  );
}

function isGeneratedApiImport(moduleSpecifier: string): boolean {
  return moduleSpecifier.endsWith("_generated/api") || moduleSpecifier.endsWith("_generated/api.js");
}

function isRawBuilderName(value: string): value is RawConvexBuilder {
  return rawBuilderNames.has(value);
}

function authenticatedBuilderName(builder: RawConvexBuilder): string {
  switch (builder) {
    case "query":
      return "authenticatedQuery";
    case "mutation":
      return "authenticatedMutation";
    case "action":
      return "authenticatedAction";
  }
}

function builderDisplaySuffix(builder: RawConvexBuilder): string {
  switch (builder) {
    case "query":
      return "Query";
    case "mutation":
      return "Mutation";
    case "action":
      return "Action";
  }
}

function includeTrailingNewline(sourceText: string, position: number): number {
  if (sourceText[position] === "\r" && sourceText[position + 1] === "\n") {
    return position + 2;
  }
  if (sourceText[position] === "\n") {
    return position + 1;
  }
  return position;
}

function applyTextReplacements(
  sourceText: string,
  replacements: Array<{ start: number; end: number; text: string }>,
): string {
  const sorted = replacements
    .filter((replacement) => replacement.start !== replacement.end || replacement.text.length > 0)
    .sort((left, right) => right.start - left.start);
  let result = sourceText;

  for (const replacement of sorted) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }

  return result;
}

function displayPathFor(cwd: string, filePath: string): string {
  const relativePath = relative(cwd, filePath);
  if (relativePath.startsWith("..")) {
    return normalizePath(filePath);
  }
  return normalizePath(relativePath || basename(filePath));
}

function normalizePath(filePath: string): string {
  return filePath.split("\\").join("/");
}

function stripKnownModuleExtension(filePath: string): string {
  return filePath.replace(/\.(?:c|m)?(?:t|j)sx?$/, "");
}
