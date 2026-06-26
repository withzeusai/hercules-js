import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import * as ts from "typescript";

type RawConvexBuilder = "query" | "mutation" | "action";
type TenantResourceHelperName =
  | "tenantFromResource"
  | "tenantFromDefaultResource"
  | "tenantFromParentResource"
  | "tenantFromDefaultParentResource";

type RawBuilderCandidate = {
  builder: RawConvexBuilder;
  builderNode: ts.Expression;
  functionName: string;
  isDirectExport: boolean;
  declaration: ts.Node;
};

export type IamCheckFinding = {
  code:
    | "convex_dir_missing"
    | "raw_exported_convex_builder"
    | "placeholder_tenant_id"
    | "hardcoded_tenant_id"
    | "default_tenant_literal_in_convex_helper"
    | "local_tenant_membership_table"
    | "optional_tenant_id"
    | "tenant_scoped_global_slug_lookup"
    | "tenant_row_from_arg"
    | "authenticated_tenant_data_read"
    | "existing_row_missing_resource_tenant"
    | "resource_capability_missing_resource"
    | "privileged_resource_permission_rule"
    | "unsafe_sdk_iam_call"
    | "authorization_args_from_public_input"
    | "runtime_superset_permission"
    | "noncanonical_permission_key"
    | "invalid_creator_bootstrap_role";
  severity: "error";
  filePath: string;
  line: number;
  column: number;
  functionName?: string;
  builder?: RawConvexBuilder;
  message: string;
  suggestion?: string;
};

export type IamCheckResult = {
  ok: boolean;
  convexDir: string;
  filesChecked: number;
  fixedFiles: number;
  findings: IamCheckFinding[];
};

export type CheckIamSourceOptions = {
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
  "iamQuery",
  "iamMutation",
  "iamAction",
]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirectories = new Set(["_generated", "node_modules", "dist", "build", ".git"]);
const exemptFileNames = new Set(["iam.ts", "iam.tsx", "http.ts", "convex.config.ts"]);
const exemptionMarkers = ["hercules-iam: allow-raw-builder", "hercules-iam: allow-raw-builders"];
const iamPackageName = "@usehercules/convex";
const herculesSdkPackageName = "@usehercules/sdk";
const iamHelpersPackageName = `${iamPackageName}/iam-helpers`;
const resourceCreatorBootstrapHelperName = "createResourceCreatorBootstrapAction";
const generatedServerModuleSpecifier = "convex:_generated/server";
const tenantResourceHelperNames = new Set<TenantResourceHelperName>([
  "tenantFromResource",
  "tenantFromDefaultResource",
  "tenantFromParentResource",
  "tenantFromDefaultParentResource",
]);
const iamAuthorizationRequestFunctionNames = new Set([
  "hasPermission",
  "requirePermission",
  "requireAnyPermission",
  "getEffectivePermissions",
]);
const iamDefaultTenantObjectFunctionNames = new Set([
  "filterAuthorizedResources",
  "getTargetTenantSyncStatus",
  "listMyRoles",
  "getTenant",
  "listTenantUsers",
  "listTenantGroups",
  "listTenantUserDirectory",
  "getTenantUserDirectoryEntry",
  "listGroupMembers",
  "listUserGroups",
  "listTenantRoles",
  "getTenantRole",
  "listTenantPermissions",
  "getResourcePermissionOverrides",
  "explainAccess",
  "listDirectSubjectsForResource",
]);

function isTenantResourceHelperName(name: string): name is TenantResourceHelperName {
  return tenantResourceHelperNames.has(name as TenantResourceHelperName);
}

function isHerculesSdkModuleSpecifier(moduleSpecifier: string): boolean {
  return (
    moduleSpecifier === herculesSdkPackageName ||
    moduleSpecifier.startsWith(`${herculesSdkPackageName}/`)
  );
}

export function checkIamSource(options: CheckIamSourceOptions = {}): IamCheckResult {
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
  // IAM into their Convex functions. A plain Convex app keeps raw
  // builder behavior, so the whole check is a pass-through no-op for it.
  const markerFiles = collectSourceFiles(convexDir, {
    includeExemptFiles: true,
  });
  if (!markerFiles.some((filePath) => fileUsesManagedIam(filePath, convexDir))) {
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
  const tenantOwnedTables = collectTenantOwnedTables(sourceFiles);
  const iamCatalog = loadIamCatalog(cwd);
  const catalogPermissionKeys = iamCatalog?.canonicalPermissionKeys ?? null;
  const fixedFiles = options.fixAuthenticated
    ? sourceFiles.filter((filePath) => fixSourceFileToAuthenticatedBuilders(filePath, convexDir))
        .length
    : 0;
  const authoritySourceFiles = collectAuthoritySourceFiles(cwd, markerFiles);
  const checkerSourceFiles = createCheckerSourceFiles(authoritySourceFiles);
  const findings = [
    ...sourceFiles.flatMap((filePath) => checkSourceFile(cwd, filePath, checkerSourceFiles)),
    ...checkSdkIamCalls(cwd, convexDir, markerFiles, checkerSourceFiles, iamCatalog),
    ...markerFiles.flatMap((filePath) => checkHardcodedTenantIds(cwd, filePath)),
    ...markerFiles.flatMap((filePath) => checkPrivilegedResourcePermissionRules(cwd, filePath)),
    ...sourceFiles.flatMap((filePath) => checkRuntimeSupersetPermissionKeys(cwd, filePath)),
    ...sourceFiles.flatMap((filePath) =>
      checkCanonicalPermissionKeys(cwd, filePath, catalogPermissionKeys),
    ),
    ...sourceFiles.flatMap((filePath) => checkIamResourcePatterns(cwd, filePath)),
    ...[...sourceFiles, ...appSourceFiles].flatMap((filePath) =>
      checkIamTenantPatterns(cwd, filePath, tenantOwnedTables),
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

export function formatIamCheckResult(result: IamCheckResult): string {
  if (result.ok) {
    const fileLabel = result.filesChecked === 1 ? "file" : "files";
    const fixedLabel =
      result.fixedFiles > 0
        ? ` ${result.fixedFiles} ${result.fixedFiles === 1 ? "file was" : "files were"} updated.`
        : "";
    return `Hercules IAM static check passed (${result.filesChecked} ${fileLabel} checked).${fixedLabel} This static check does not prove runtime role decisions or control-plane writes are authorized.`;
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

function fixSourceFileToAuthenticatedBuilders(filePath: string, convexDir: string): boolean {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const rawBuilderImports = collectRawBuilderImports(sourceFile);
  if (rawBuilderImports.size === 0) {
    return false;
  }

  const exportedNames = collectExportedNames(sourceFile);
  const candidates = collectDirectRawBuilderCandidates(sourceFile, rawBuilderImports)
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
  const iamImports = new Set(replacements.map((replacement) => replacement.text));
  replacements.push(...buildGeneratedServerImportRemovals(sourceFile, sourceText, candidates));
  replacements.push(buildIamImportReplacement(sourceFile, sourceText, iamImports, convexDir));

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

function collectAppSourceFiles(
  cwd: string,
  convexDir: string,
  options: { includeExemptFiles?: boolean } = {},
): string[] {
  const srcDir = resolve(cwd, "src");
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) return [];
  if (srcDir === convexDir) return [];
  return collectSourceFiles(srcDir, options);
}

function collectAuthoritySourceFiles(cwd: string, rootFilePaths: string[]): string[] {
  const sourceFiles = new Set<string>();
  const pending = [...rootFilePaths].sort((left, right) => left.localeCompare(right));

  while (pending.length > 0) {
    const filePath = pending.shift()!;
    if (sourceFiles.has(filePath) || !isProjectSourceFile(cwd, filePath)) {
      continue;
    }
    sourceFiles.add(filePath);

    const sourceFile = createSourceFile(filePath, readFileSync(filePath, "utf8"));
    for (const moduleSpecifier of collectRelativeModuleSpecifiers(sourceFile)) {
      const targetFilePath = resolveExistingLocalSourceFile(cwd, filePath, moduleSpecifier);
      if (targetFilePath && !sourceFiles.has(targetFilePath)) {
        pending.push(targetFilePath);
        pending.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  return [...sourceFiles].sort((left, right) => left.localeCompare(right));
}

function collectRelativeModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const moduleSpecifiers = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      moduleSpecifiers.add(statement.moduleSpecifier.text);
    }
  }
  return [...moduleSpecifiers].sort((left, right) => left.localeCompare(right));
}

function resolveExistingLocalSourceFile(
  cwd: string,
  fromFilePath: string,
  moduleSpecifier: string,
): string | null {
  for (const candidate of localSourceFileCandidates(fromFilePath, moduleSpecifier)) {
    if (
      isProjectSourceFile(cwd, candidate) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return null;
}

function isProjectSourceFile(cwd: string, filePath: string): boolean {
  if (!isSourceFile(filePath)) return false;
  const relativePath = relative(cwd, filePath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    resolve(cwd, relativePath) !== filePath
  ) {
    return false;
  }
  return normalizePath(relativePath)
    .split("/")
    .every((segment) => !ignoredDirectories.has(segment));
}

function checkSourceFile(
  cwd: string,
  filePath: string,
  sourceFiles: Map<string, CheckerSourceFile>,
): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile =
    sourceFiles.get(filePath)?.sourceFile ?? createSourceFile(filePath, sourceText);

  const exportedNames = collectExportedNames(sourceFile);
  const candidates = collectStaticRawBuilderCandidates(sourceFile, sourceFiles);
  return candidates
    .filter((candidate) => candidate.isDirectExport || exportedNames.has(candidate.functionName))
    .filter((candidate) => !hasLocalExemption(sourceFile, sourceText, candidate.declaration))
    .map((candidate) => createFinding(cwd, sourceFile, candidate));
}

function checkIamTenantPatterns(
  cwd: string,
  filePath: string,
  tenantOwnedTables: Set<string>,
): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: IamCheckFinding[] = [];

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "placeholder_tenant_id",
    pattern:
      /\b(?:herculesTenantId|tenantId|herculesScopeId|accessScopeId|orgScopeId)\s*:\s*["']{2}/,
    message:
      "Do not store a blank Hercules IAM tenant id. Create a Hercules IAM tenant first, then persist the returned tenantId.",
    suggestion:
      "Create the tenant with hercules.iam.tenants.create from an authenticatedAction, then persist the returned tenantId.",
  });

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "local_tenant_membership_table",
    pattern:
      /\b(?:memberships|membership|tenantMembers|orgMembers|organizationMembers)\s*:\s*defineTable\b/,
    message: "Managed IAM apps should not define app-local tenant membership tables.",
    suggestion:
      "Use Hercules IAM users, groups, and role grants. Store only tenant metadata in app tables.",
  });

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "optional_tenant_id",
    pattern: /\b(?:tenantId|orgScopeId)\s*:\s*v\.optional\s*\(\s*v\.string\s*\(\s*\)\s*\)/,
    message: "Tenant-owned rows should require tenantId.",
    suggestion:
      "Backfill existing rows during conversion, then store tenantId as v.string() on tenant-owned tables.",
  });

  if (
    /\b(?:tenantId|orgScopeId)\b/.test(sourceText) &&
    /\.withIndex\s*\(\s*["']by_slug["']/.test(sourceText)
  ) {
    addPatternFinding({
      findings,
      cwd,
      filePath,
      sourceText,
      code: "tenant_scoped_global_slug_lookup",
      pattern: /\.withIndex\s*\(\s*["']by_slug["']/,
      message: "Tenant-scoped slug lookups must include tenantId in the index.",
      suggestion:
        'Use an index such as by_tenant_and_slug on ["tenantId", "slug"] and query both values together.',
    });
  }

  for (const definition of collectManagedBuilderDefinitions(sourceFile, [
    "iamQuery",
    "iamMutation",
    "iamAction",
  ])) {
    if (
      /\btenantFromArg\s*\(\s*["']tenantId["']\s*\)/.test(definition.text) &&
      /\bctx\.db\.(?:patch|replace|delete)\s*\(\s*args\.[A-Za-z_$][\w$]*/.test(definition.text)
    ) {
      findings.push(
        createPatternFindingAtNode({
          cwd,
          sourceFile,
          node: definition.node,
          code: "tenant_row_from_arg",
          message:
            "Mutations of a tenant-owned row id must authorize against the stored row tenant, not a caller supplied tenant id.",
          suggestion:
            'Use tenantFromResource("tableName", "rowIdArg") for update, publish, moderation, and delete operations.',
        }),
      );
    }
  }

  for (const definition of collectManagedBuilderDefinitions(sourceFile, ["authenticatedQuery"])) {
    const readsTenantOwnedTable = [...tenantOwnedTables].some((tableName) => {
      const escapedName = escapeRegExp(tableName);
      return (
        new RegExp(`\\.query\\s*\\(\\s*["']${escapedName}["']`).test(definition.text) ||
        (new RegExp(`v\\.id\\s*\\(\\s*["']${escapedName}["']`).test(definition.text) &&
          /\bctx\.db\.get\s*\(\s*args\.[A-Za-z_$][\w$]*/.test(definition.text))
      );
    });
    if (readsTenantOwnedTable) {
      findings.push(
        createPatternFindingAtNode({
          cwd,
          sourceFile,
          node: definition.node,
          code: "authenticated_tenant_data_read",
          message: "Authenticated reads of tenant-owned data do not prove tenant access.",
          suggestion:
            "Use iamQuery for private tenant data. Use publicQuery only for explicitly public rows filtered to public state.",
        }),
      );
    }
  }

  return findings;
}

function checkIamResourcePatterns(cwd: string, filePath: string): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: IamCheckFinding[] = [];
  const checkPermissionsNames = collectImportedNames(sourceFile, "checkPermissions");

  for (const definition of collectManagedBuilderDefinitions(sourceFile, [
    "iamQuery",
    "iamMutation",
    "iamAction",
  ])) {
    if (!findDirectArgsRowAccess(definition.definition)) continue;

    const config = unwrapExpression(definition.definition);
    if (ts.isObjectLiteralExpression(config) && !hasObjectProperty(config, "tenant")) {
      findings.push(
        createPatternFindingAtNode({
          cwd,
          sourceFile,
          node: definition.node,
          code: "existing_row_missing_resource_tenant",
          message: "Existing-row IAM operations must authorize against the loaded resource.",
          suggestion:
            'Use tenantFromDefaultResource("tableName", "rowIdArg") for the default tenant or tenantFromResource("tableName", "rowIdArg") for any other tenant.',
        }),
      );
    }
  }

  if (checkPermissionsNames.size === 0) return findings;
  for (const definition of collectManagedBuilderDefinitions(sourceFile, ["iamQuery"])) {
    if (!findDirectArgsRowAccess(definition.definition)) continue;
    visitCheckPermissionsCalls(definition.definition, (call) => {
      const target = unwrapExpression(call.expression);
      if (!ts.isIdentifier(target) || !checkPermissionsNames.has(target.text)) return;

      const requests = call.arguments[1] && unwrapExpression(call.arguments[1]);
      if (!requests || !ts.isArrayLiteralExpression(requests)) return;

      for (const request of requests.elements) {
        const value = unwrapExpression(request as ts.Expression);
        if (
          !ts.isObjectLiteralExpression(value) ||
          value.properties.some(ts.isSpreadAssignment) ||
          hasObjectProperty(value, "resource")
        ) {
          continue;
        }
        findings.push(
          createPatternFindingAtNode({
            cwd,
            sourceFile,
            node: value,
            code: "resource_capability_missing_resource",
            message: "Row capability checks must include the concrete resource.",
            suggestion:
              'Add resource: { type: "app.resource", id: String(row._id) } and include its trusted ancestor chain when applicable.',
          }),
        );
      }
    });
  }

  return findings;
}

function collectTenantOwnedTables(sourceFiles: string[]): Set<string> {
  const tableNames = new Set<string>();
  for (const filePath of sourceFiles) {
    if (!/^schema\.(?:ts|tsx|js|jsx)$/.test(basename(filePath))) continue;

    const sourceText = readFileSync(filePath, "utf8");
    const tablePattern = /\b([A-Za-z_$][\w$]*)\s*:\s*defineTable\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
    for (const match of sourceText.matchAll(tablePattern)) {
      if (/\b(?:tenantId|orgScopeId)\s*:/.test(match[2] ?? "")) {
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

function findDirectArgsRowAccess(definition: ts.Expression): ts.CallExpression | null {
  let match: ts.CallExpression | null = null;

  function visit(node: ts.Node): void {
    if (match || !ts.isCallExpression(node)) {
      if (!match) ts.forEachChild(node, visit);
      return;
    }

    const target = unwrapExpression(node.expression);
    const rowId = node.arguments[0] && unwrapExpression(node.arguments[0]);
    if (
      ts.isPropertyAccessExpression(target) &&
      new Set(["get", "patch", "replace", "delete"]).has(target.name.text) &&
      ts.isPropertyAccessExpression(target.expression) &&
      target.expression.name.text === "db" &&
      ts.isIdentifier(target.expression.expression) &&
      target.expression.expression.text === "ctx" &&
      rowId &&
      ts.isPropertyAccessExpression(rowId) &&
      ts.isIdentifier(rowId.expression) &&
      rowId.expression.text === "args"
    ) {
      match = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(definition);
  return match;
}

function visitCheckPermissionsCalls(
  definition: ts.Expression,
  visitCall: (call: ts.CallExpression) => void,
): void {
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      visitCall(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(definition);
}

function collectImportedNames(sourceFile: ts.SourceFile, importedName: string): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    for (const element of statement.importClause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      if ((element.propertyName ?? element.name).text === importedName) {
        names.add(element.name.text);
      }
    }
  }

  return names;
}

function hasObjectProperty(object: ts.ObjectLiteralExpression, propertyName: string): boolean {
  return object.properties.some((property) => {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property) &&
      !ts.isMethodDeclaration(property) &&
      !ts.isGetAccessorDeclaration(property) &&
      !ts.isSetAccessorDeclaration(property)
    ) {
      return false;
    }
    const name = property.name;
    return (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === propertyName;
  });
}

function checkHardcodedTenantIds(cwd: string, filePath: string): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const findings: IamCheckFinding[] = [];

  addPatternFinding({
    findings,
    cwd,
    filePath,
    sourceText,
    code: "hardcoded_tenant_id",
    pattern:
      /\b(?:[A-Z][A-Z0-9_]*_)?(?:(?:ACCESS_)?SCOPE|TENANT)_ID\b\s*=\s*["']01[A-Z0-9]{24}["']|\b(?:scopeId|tenantId)\s*:\s*["']01[A-Z0-9]{24}["']/,
    message: "Do not hardcode IAM tenant ids.",
    suggestion:
      "Use the default tenant helper, or store tenant ids returned by hercules.iam.tenants.create on app rows and load them from the row.",
  });

  return findings;
}

function checkPrivilegedResourcePermissionRules(cwd: string, filePath: string): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: IamCheckFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const permission =
        getStringProperty(node, "permission_key") ?? getStringProperty(node, "permissionKey");
      const effect = getStringProperty(node, "effect");
      if (
        permission &&
        effect?.value === "allow" &&
        isPrivilegedResourceRuleKey(permission.value)
      ) {
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

type CheckerSourceFile = {
  filePath: string;
  sourceFile: ts.SourceFile;
  internalApiNames: Set<string>;
  bindings: Map<string, ScopedBinding>;
  imports: Map<string, ImportedBinding>;
  namespaceImports: Map<string, ModuleTarget>;
  exportBindings: Map<string, string>;
  reExports: Map<string, ImportedBinding>;
  namespaceReExports: Map<string, ModuleTarget>;
  exportAllTargets: ModuleTarget[];
};

type ModuleTarget =
  | { kind: "local"; filePath: string }
  | { kind: "external"; moduleSpecifier: string };

type ImportedBinding = {
  target: ModuleTarget;
  exportedName: string;
};

type BindingValue =
  | { kind: "unknown" }
  | {
      kind: "expression";
      expression: ts.Expression;
      expressionInfo?: CheckerSourceFile;
      scope: LexicalScope | null;
      propertyPath: string[];
    }
  | {
      kind: "callable";
      node: ts.FunctionLikeDeclaration;
      scope: LexicalScope | null;
    };

type ScopedBinding = {
  id: string;
  node: ts.Node;
  value: BindingValue;
};

type LexicalScope = {
  parent: LexicalScope | null;
  bindings: Map<string, ScopedBinding>;
};

type StaticValue =
  | {
      kind: "node";
      info: CheckerSourceFile;
      node: ts.Node;
      declarationScope: LexicalScope | null;
    }
  | {
      kind: "convexFunction";
      info: CheckerSourceFile;
      call: ts.CallExpression;
      declarationScope: LexicalScope | null;
      builder: ConvexFunctionBuilder;
    }
  | {
      kind: "resourceCreatorBootstrap";
      info: CheckerSourceFile;
      call: ts.CallExpression;
      declarationScope: LexicalScope | null;
    }
  | { kind: "module"; target: ModuleTarget }
  | {
      kind: "known";
      value:
        | "herculesSdkConstructor"
        | "herculesSdkClient"
        | "herculesSdkIam"
        | "iamCheckPermissions"
        | "iamAuthorizationRequestFunction"
        | "iamResourceSharingRecipientsFunction"
        | "iamDefaultTenantObjectFunction"
        | "createIamFactory"
        | "iamBuilders"
        | "resourceCreatorBootstrapFactory"
        | TenantResourceHelperName
        | ConvexFunctionBuilder;
    };

type ConvexFunctionBuilder =
  | "publicQuery"
  | "publicMutation"
  | "publicAction"
  | "authenticatedQuery"
  | "authenticatedMutation"
  | "authenticatedAction"
  | "iamQuery"
  | "iamMutation"
  | "iamAction"
  | "rawAction"
  | "internalAction";

type SdkIamAuthorityMode = "user" | "service" | "reject";

type AuthorityState = {
  mode: SdkIamAuthorityMode;
  ctxBindings: Set<ScopedBinding>;
  publicArgsBindings: Set<ScopedBinding>;
  trackPublicArgs: boolean;
  checkedTokenBindings: Set<ScopedBinding>;
  checkedIdentityTokenBindings: Set<ScopedBinding>;
};

function createCheckerSourceFiles(filePaths: string[]): Map<string, CheckerSourceFile> {
  const sourceFiles = new Map<string, CheckerSourceFile>();
  for (const filePath of filePaths) {
    const sourceFile = createSourceFile(filePath, readFileSync(filePath, "utf8"));
    sourceFiles.set(filePath, {
      filePath,
      sourceFile,
      internalApiNames: collectInternalApiNames(sourceFile),
      bindings: collectTopLevelBindings(sourceFile),
      imports: new Map(),
      namespaceImports: new Map(),
      exportBindings: collectExportBindings(sourceFile),
      reExports: new Map(),
      namespaceReExports: new Map(),
      exportAllTargets: [],
    });
  }

  for (const info of sourceFiles.values()) {
    const imports = collectModuleImports(info.sourceFile, sourceFiles);
    info.imports = imports.bindings;
    info.namespaceImports = imports.namespaces;
    const reExports = collectModuleReExports(info.sourceFile, sourceFiles);
    info.reExports = reExports.bindings;
    info.namespaceReExports = reExports.namespaces;
    info.exportAllTargets = reExports.exportAllTargets;
  }

  return sourceFiles;
}

function checkSdkIamCalls(
  cwd: string,
  convexDir: string,
  rootFilePaths: string[],
  sourceFiles: Map<string, CheckerSourceFile>,
  iamCatalog: IamCatalog | null,
): IamCheckFinding[] {
  const convexModules = new Map<string, CheckerSourceFile>();
  for (const info of sourceFiles.values()) {
    const relativePath = normalizePath(relative(convexDir, info.filePath));
    if (relativePath.startsWith("../")) continue;
    convexModules.set(stripKnownModuleExtension(relativePath), info);
  }
  const findings: IamCheckFinding[] = [];
  const findingKeys = new Set<string>();
  const visitedCallables = new Set<string>();
  const visitedConvexFunctions = new Set<string>();
  const visitedResourceCreatorBootstraps = new Set<string>();
  const visitedAuthorizationProviders = new Set<string>();

  const addFinding = (info: CheckerSourceFile, node: ts.Node, state: AuthorityState) => {
    const key = `${info.filePath}:${node.getStart(info.sourceFile)}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    const message =
      state.mode === "service"
        ? "Internal Convex actions that call Hercules SDK IAM methods must pass literal actor_token_identifier: null."
        : state.mode === "user"
          ? "Authenticated Convex actions that call Hercules SDK IAM methods must pass actor_token_identifier from ctx.auth.getUserIdentity().tokenIdentifier after a fail-closed presence check."
          : "Public or unauthenticated Convex flows must not call Hercules SDK IAM methods.";
    findings.push(
      createPatternFindingAtNode({
        cwd,
        sourceFile: info.sourceFile,
        node,
        code: "unsafe_sdk_iam_call",
        message,
        suggestion:
          "Use authenticatedAction or iamAction with actor_token_identifier from the action identity, or keep service IAM SDK calls in internalAction with actor_token_identifier: null.",
      }),
    );
  };

  const addAuthorizationArgsFinding = (
    info: CheckerSourceFile,
    node: ts.Node,
    kind: "resource type" | "ancestors" | "permission",
  ) => {
    const key = `${info.filePath}:authorization-args:${kind}:${node.getStart(info.sourceFile)}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(
      createPatternFindingAtNode({
        cwd,
        sourceFile: info.sourceFile,
        node,
        code: "authorization_args_from_public_input",
        message:
          kind === "resource type"
            ? "Authorization resource type must not be copied directly from public function args."
            : kind === "ancestors"
              ? "Authorization ancestors must not be copied directly from public function args."
              : "Authorization permission must not be copied directly from public function args.",
        suggestion:
          kind === "resource type"
            ? "Use a fixed catalog resource type, or load the app row server-side and derive authorization from trusted data."
            : kind === "ancestors"
              ? "Load the app row or parent row server-side and derive ancestors from trusted app data before authorizing."
              : "Use a fixed catalog permission, or derive the permission server-side from trusted data before authorizing.",
      }),
    );
  };

  const addInvalidDefaultTenantLiteralFinding = (info: CheckerSourceFile, node: ts.Node) => {
    const key = `${info.filePath}:default-tenant-literal:${node.getStart(info.sourceFile)}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(
      createPatternFindingAtNode({
        cwd,
        sourceFile: info.sourceFile,
        node,
        code: "default_tenant_literal_in_convex_helper",
        message: 'The public "default" tenant sentinel is not valid in Convex IAM helper calls.',
        suggestion:
          'Omit tenantId when it is optional, or pass the persisted canonical tenant ID. Use "default" only with generated SDK or REST APIs.',
      }),
    );
  };

  const addBootstrapFinding = (info: CheckerSourceFile, node: ts.Node, message: string) => {
    const key = `${info.filePath}:bootstrap-role:${node.getStart(info.sourceFile)}:${message}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(
      createPatternFindingAtNode({
        cwd,
        sourceFile: info.sourceFile,
        node,
        code: "invalid_creator_bootstrap_role",
        message,
        suggestion:
          "Use a fixed reusable catalog role whose privileged permissions are grantable on the bootstrap resource type, or leave dynamic tenant-created roles to runtime validation.",
      }),
    );
  };

  const visitCallableNode = (
    info: CheckerSourceFile,
    node: ts.Node,
    declarationScope: LexicalScope | null,
    state: AuthorityState,
    options: {
      markFirstParameterAsCtx?: boolean;
      callArguments?: readonly ts.Expression[];
      callInfo?: CheckerSourceFile;
      callScope?: LexicalScope | null;
    } = {},
  ): void => {
    const argumentInfo = options.callInfo ?? info;
    const argumentScope = options.callScope ?? null;
    const ctxArgumentMask =
      options.callArguments
        ?.map((argument) =>
          isActionCtxExpression(argumentInfo, argument, argumentScope, state, new Set())
            ? "1"
            : "0",
        )
        .join("") ?? "";
    const publicArgsArgumentSignature =
      options.callArguments
        ?.map((argument) =>
          containsDirectPublicArgsValue(argumentInfo, argument, argumentScope, state)
            ? `${argumentInfo.filePath}@${argument.getStart(argumentInfo.sourceFile)}`
            : "0",
        )
        .join(",") ?? "";
    const callableKey = `${info.filePath}:${node.getStart(info.sourceFile)}:${state.mode}:${
      options.markFirstParameterAsCtx === true ? "handler" : "helper"
    }:${ctxArgumentMask}:${publicArgsArgumentSignature}`;
    if (visitedCallables.has(callableKey)) return;
    visitedCallables.add(callableKey);

    if (!isCallableNode(node)) return;
    const functionScope: LexicalScope = {
      parent: declarationScope,
      bindings: new Map(),
    };
    const functionState = cloneAuthorityState(state);
    node.parameters.forEach((parameter, index) => {
      addBindingNames(functionScope, parameter.name, parameter, functionScope);
      const argument = options.callArguments?.[index];
      if (argument) {
        for (const name of collectBindingNames(parameter.name)) {
          const binding = functionScope.bindings.get(name);
          if (binding) {
            binding.value = {
              kind: "expression",
              expression: argument,
              expressionInfo: options.callInfo ?? info,
              scope: options.callScope ?? null,
              propertyPath: [],
            };
          }
        }
      }
      const markAsCtx =
        (options.markFirstParameterAsCtx === true && index === 0) ||
        (options.callArguments?.[index] !== undefined &&
          isActionCtxExpression(
            argumentInfo,
            options.callArguments[index]!,
            argumentScope,
            state,
            new Set(),
          ));
      if (markAsCtx) {
        for (const name of collectBindingNames(parameter.name)) {
          const binding = functionScope.bindings.get(name);
          if (binding) functionState.ctxBindings.add(binding);
        }
      }
      const markAsPublicArgs =
        (state.trackPublicArgs && options.markFirstParameterAsCtx === true && index === 1) ||
        (options.callArguments?.[index] !== undefined &&
          isDirectPublicArgsValue(
            argumentInfo,
            options.callArguments[index]!,
            argumentScope,
            state,
            new Set(),
          ));
      if (markAsPublicArgs) {
        for (const name of collectBindingNames(parameter.name)) {
          const binding = functionScope.bindings.get(name);
          if (binding) functionState.publicArgsBindings.add(binding);
        }
      }
    });

    const body = node.body;
    if (!body) return;
    if (ts.isBlock(body)) {
      visitBlock(info, body, functionScope, functionState);
    } else {
      visitReachable(info, body, functionScope, functionState);
    }
  };

  function resolveBindingValues(
    info: CheckerSourceFile,
    binding: ScopedBinding,
    resolving: Set<string>,
  ): StaticValue[] {
    const bindingKey = `${info.filePath}:binding:${binding.id}`;
    if (resolving.has(bindingKey)) return [];
    const nextResolving = new Set(resolving).add(bindingKey);

    if (binding.value.kind === "unknown") return [];
    if (binding.value.kind === "callable") {
      return [
        {
          kind: "node",
          info,
          node: binding.value.node,
          declarationScope: binding.value.scope,
        },
      ];
    }

    const expressionInfo = binding.value.expressionInfo ?? info;
    let values = resolveStaticValues(
      expressionInfo,
      binding.value.expression,
      binding.value.scope,
      nextResolving,
    );
    for (const propertyName of binding.value.propertyPath) {
      values = values.flatMap((value) => resolvePropertyValues(value, propertyName, nextResolving));
    }
    return values;
  }

  function resolveModuleExportValues(
    target: ModuleTarget,
    exportedName: string,
    resolving: Set<string>,
  ): StaticValue[] {
    if (target.kind === "local") {
      const targetInfo = sourceFiles.get(target.filePath);
      return targetInfo ? resolveExportedValues(targetInfo, exportedName, resolving) : [];
    }
    if (isHerculesSdkModuleSpecifier(target.moduleSpecifier)) {
      return exportedName === "Hercules" || exportedName === "default"
        ? [{ kind: "known", value: "herculesSdkConstructor" }]
        : [];
    }
    if (target.moduleSpecifier === iamPackageName && exportedName === "createIam") {
      return [{ kind: "known", value: "createIamFactory" }];
    }
    if (target.moduleSpecifier === iamPackageName && isTenantResourceHelperName(exportedName)) {
      return [{ kind: "known", value: exportedName }];
    }
    if (
      target.moduleSpecifier === iamHelpersPackageName &&
      exportedName === resourceCreatorBootstrapHelperName
    ) {
      return [{ kind: "known", value: "resourceCreatorBootstrapFactory" }];
    }
    if (target.moduleSpecifier === generatedServerModuleSpecifier) {
      if (exportedName === "action") {
        return [{ kind: "known", value: "rawAction" }];
      }
      if (exportedName === "internalAction") {
        return [{ kind: "known", value: "internalAction" }];
      }
    }
    return [];
  }

  function resolveExportedValues(
    info: CheckerSourceFile,
    exportedName: string,
    resolving: Set<string>,
  ): StaticValue[] {
    const symbolKey = `${info.filePath}:export:${exportedName}`;
    if (resolving.has(symbolKey)) return [];
    const nextResolving = new Set(resolving).add(symbolKey);

    if (isIamWiringSourceFile(info.filePath, convexDir)) {
      if (publicBuilderNames.has(exportedName)) {
        return [{ kind: "known", value: exportedName as ConvexFunctionBuilder }];
      }
    }

    const localName = info.exportBindings.get(exportedName);
    if (localName) {
      const binding = info.bindings.get(localName);
      if (binding) {
        return resolveBindingValues(info, binding, nextResolving);
      }
      const imported = info.imports.get(localName);
      if (imported) {
        return resolveModuleExportValues(imported.target, imported.exportedName, nextResolving);
      }
      const namespaceImport = info.namespaceImports.get(localName);
      if (namespaceImport) {
        return [{ kind: "module", target: namespaceImport }];
      }
    }

    const reExport = info.reExports.get(exportedName);
    if (reExport) {
      return resolveModuleExportValues(reExport.target, reExport.exportedName, nextResolving);
    }

    const namespaceReExport = info.namespaceReExports.get(exportedName);
    if (namespaceReExport) {
      return [{ kind: "module", target: namespaceReExport }];
    }

    const values: StaticValue[] = [];
    for (const target of info.exportAllTargets) {
      values.push(...resolveModuleExportValues(target, exportedName, nextResolving));
    }
    return values;
  }

  function resolveObjectPropertyValues(
    info: CheckerSourceFile,
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
    scope: LexicalScope | null,
    resolving: Set<string>,
  ): StaticValue[] {
    for (let index = objectLiteral.properties.length - 1; index >= 0; index -= 1) {
      const property = objectLiteral.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
        const spreadValues = resolveStaticValues(
          info,
          property.expression,
          scope,
          resolving,
        ).flatMap((value) => resolvePropertyValues(value, propertyName, resolving));
        if (spreadValues.length > 0) return spreadValues;
        continue;
      }
      const name = property.name;
      const nameText =
        name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null;
      if (nameText !== propertyName) continue;

      if (ts.isMethodDeclaration(property)) {
        return [
          {
            kind: "node",
            info,
            node: property,
            declarationScope: scope,
          },
        ];
      }
      if (ts.isPropertyAssignment(property)) {
        return resolveStaticValues(info, property.initializer, scope, resolving);
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return resolveStaticValues(info, property.name, scope, resolving);
      }
    }
    return [];
  }

  function resolvePropertyValues(
    value: StaticValue,
    propertyName: string,
    resolving: Set<string>,
  ): StaticValue[] {
    if (value.kind === "module") {
      return resolveModuleExportValues(value.target, propertyName, resolving);
    }
    if (value.kind === "known") {
      if (value.value === "herculesSdkClient" && propertyName === "iam") {
        return [{ kind: "known", value: "herculesSdkIam" }];
      }
      if (value.value === "herculesSdkIam") {
        return [{ kind: "known", value: "herculesSdkIam" }];
      }
      if (value.value === "iamBuilders") {
        if (propertyName === "checkPermissions") {
          return [{ kind: "known", value: "iamCheckPermissions" }];
        }
        if (iamAuthorizationRequestFunctionNames.has(propertyName)) {
          return [{ kind: "known", value: "iamAuthorizationRequestFunction" }];
        }
        if (propertyName === "listResourceSharingRecipients") {
          return [{ kind: "known", value: "iamResourceSharingRecipientsFunction" }];
        }
        if (propertyName === "listTenantMemberPickerUsers") {
          return [{ kind: "known", value: "iamAuthorizationRequestFunction" }];
        }
        if (iamDefaultTenantObjectFunctionNames.has(propertyName)) {
          return [{ kind: "known", value: "iamDefaultTenantObjectFunction" }];
        }
        if (publicBuilderNames.has(propertyName)) {
          return [{ kind: "known", value: propertyName as ConvexFunctionBuilder }];
        }
      }
      return [];
    }
    if (value.kind !== "node") {
      return [];
    }
    if (ts.isObjectLiteralExpression(value.node)) {
      return resolveObjectPropertyValues(
        value.info,
        value.node,
        propertyName,
        value.declarationScope,
        resolving,
      );
    }
    if (ts.isArrayLiteralExpression(value.node)) {
      const index = Number(propertyName);
      if (!Number.isInteger(index) || index < 0) return [];
      const element = value.node.elements[index];
      return element && !ts.isOmittedExpression(element)
        ? resolveStaticValues(value.info, element, value.declarationScope, resolving)
        : [];
    }
    return [];
  }

  function resolveStaticValues(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    resolving: Set<string> = new Set(),
  ): StaticValue[] {
    const target = unwrapExpression(expression);
    if (isCallableNode(target)) {
      return [{ kind: "node", info, node: target, declarationScope: scope }];
    }
    if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
      return [{ kind: "node", info, node: target, declarationScope: scope }];
    }
    if (ts.isAwaitExpression(target)) {
      return resolveStaticValues(info, target.expression, scope, resolving);
    }
    if (ts.isConditionalExpression(target)) {
      return [
        ...resolveStaticValues(info, target.whenTrue, scope, new Set(resolving)),
        ...resolveStaticValues(info, target.whenFalse, scope, new Set(resolving)),
      ];
    }

    if (ts.isIdentifier(target)) {
      const lexicalBinding = findLexicalBinding(scope, target.text);
      if (lexicalBinding) {
        return resolveBindingValues(info, lexicalBinding, resolving);
      }

      const symbolKey = `${info.filePath}:local:${target.text}`;
      if (resolving.has(symbolKey)) return [];
      const nextResolving = new Set(resolving).add(symbolKey);

      const binding = info.bindings.get(target.text);
      if (binding) {
        return resolveBindingValues(info, binding, nextResolving);
      }

      const imported = info.imports.get(target.text);
      if (imported) {
        return resolveModuleExportValues(imported.target, imported.exportedName, nextResolving);
      }

      const namespaceImport = info.namespaceImports.get(target.text);
      if (namespaceImport) {
        return [{ kind: "module", target: namespaceImport }];
      }
      return [];
    }

    if (ts.isPropertyAccessExpression(target)) {
      if (
        target.name.text === "call" ||
        target.name.text === "apply" ||
        target.name.text === "bind"
      ) {
        return resolveStaticValues(info, target.expression, scope, resolving);
      }

      const objectValues = resolveStaticValues(info, target.expression, scope, resolving);
      return objectValues.flatMap((value) =>
        resolvePropertyValues(value, target.name.text, resolving),
      );
    }

    if (ts.isElementAccessExpression(target)) {
      const argument = target.argumentExpression && unwrapExpression(target.argumentExpression);
      if (!argument || !ts.isStringLiteralLike(argument)) return [];
      const objectValues = resolveStaticValues(info, target.expression, scope, resolving);
      return objectValues.flatMap((value) =>
        resolvePropertyValues(value, argument.text, resolving),
      );
    }

    if (ts.isNewExpression(target)) {
      return resolveStaticValues(info, target.expression, scope, resolving).flatMap((value) =>
        value.kind === "known" && value.value === "herculesSdkConstructor"
          ? [{ kind: "known", value: "herculesSdkClient" }]
          : [],
      );
    }

    if (ts.isCallExpression(target)) {
      const callTarget = unwrapExpression(target.expression);
      if (ts.isPropertyAccessExpression(callTarget) && callTarget.name.text === "bind") {
        return resolveStaticValues(info, callTarget.expression, scope, resolving);
      }

      const values: StaticValue[] = [];
      for (const callable of resolveStaticValues(info, target.expression, scope, resolving)) {
        const builder =
          callable.kind === "known" ? convexBuilderForKnownValue(callable.value) : null;
        if (builder) {
          values.push({
            kind: "convexFunction",
            info,
            call: target,
            declarationScope: scope,
            builder,
          });
        } else if (callable.kind === "known" && callable.value === "herculesSdkConstructor") {
          values.push({ kind: "known", value: "herculesSdkClient" });
        } else if (callable.kind === "known" && callable.value === "createIamFactory") {
          values.push({ kind: "known", value: "iamBuilders" });
        } else if (
          callable.kind === "known" &&
          callable.value === "resourceCreatorBootstrapFactory"
        ) {
          values.push({
            kind: "resourceCreatorBootstrap",
            info,
            call: target,
            declarationScope: scope,
          });
        } else if (callable.kind === "node" && isCallableNode(callable.node)) {
          values.push(...resolveCallableReturnValues(callable, new Set(resolving)));
        }
      }
      return values;
    }

    if (
      ts.isBinaryExpression(target) &&
      (target.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return [
        ...resolveStaticValues(info, target.left, scope, new Set(resolving)),
        ...resolveStaticValues(info, target.right, scope, new Set(resolving)),
      ];
    }

    return [];
  }

  function resolveCallableReturnValues(
    callable: Extract<StaticValue, { kind: "node" }>,
    resolving: Set<string>,
  ): StaticValue[] {
    if (!isCallableNode(callable.node) || !callable.node.body) return [];
    const returnKey = `${callable.info.filePath}:returns:${callable.node.pos}`;
    if (resolving.has(returnKey)) return [];
    const nextResolving = new Set(resolving).add(returnKey);
    const functionScope = createChildScope(callable.declarationScope);
    for (const parameter of callable.node.parameters) {
      addBindingNames(functionScope, parameter.name, parameter, functionScope);
    }

    if (!ts.isBlock(callable.node.body)) {
      return resolveStaticValues(callable.info, callable.node.body, functionScope, nextResolving);
    }

    const values: StaticValue[] = [];
    const collectReturns = (node: ts.Node, scope: LexicalScope): void => {
      if (ts.isReturnStatement(node)) {
        if (node.expression) {
          values.push(...resolveStaticValues(callable.info, node.expression, scope, nextResolving));
        }
        return;
      }
      if (isCallableNode(node)) return;
      if (ts.isBlock(node)) {
        const blockScope = createChildScope(scope);
        collectDirectBlockBindings(node, blockScope);
        for (const statement of node.statements) {
          if (ts.isFunctionDeclaration(statement)) continue;
          collectReturns(statement, blockScope);
        }
        return;
      }
      if (ts.isIfStatement(node)) {
        collectReturns(node.expression, scope);
        const before = snapshotBindingValues(scope);
        collectReturns(node.thenStatement, scope);
        const afterThen = snapshotBindingValues(scope);
        restoreBindingValues(before);
        if (node.elseStatement) {
          collectReturns(node.elseStatement, scope);
        }
        const afterElse = snapshotBindingValues(scope);
        mergeBindingValues(before, [afterThen, afterElse]);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        assignBindingExpression(node.left, node.right, scope);
        return;
      }
      ts.forEachChild(node, (child) => collectReturns(child, scope));
    };
    collectReturns(callable.node.body, functionScope);
    return values;
  }

  function resolveInternalApiReferenceValues(
    node: ts.Node,
    info: CheckerSourceFile,
    scope: LexicalScope | null,
  ): StaticValue[] {
    const path = getInternalApiReferencePath(node, info, scope, new Set());
    if (path === null || path.length === 0) return [];

    let moduleInfo: CheckerSourceFile | undefined;
    let moduleSegmentCount = 0;
    for (let length = path.length - 1; length >= 1; length -= 1) {
      const candidate = convexModules.get(path.slice(0, length).join("/"));
      if (candidate) {
        moduleInfo = candidate;
        moduleSegmentCount = length;
        break;
      }
    }

    if (!moduleInfo) {
      return [];
    }

    const exportedPath = path.slice(moduleSegmentCount);
    if (exportedPath.length === 0) return [];
    let values = resolveExportedValues(moduleInfo, exportedPath[0]!, new Set());
    for (const propertyName of exportedPath.slice(1)) {
      values = values.flatMap((value) => resolvePropertyValues(value, propertyName, new Set()));
    }
    return values;
  }

  const visitCallableReference = (
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    options: {
      markFirstParameterAsCtx?: boolean;
      callArguments?: readonly ts.Expression[];
      callInfo?: CheckerSourceFile;
      callScope?: LexicalScope | null;
      resolving?: Set<string>;
    } = {},
  ): void => {
    for (const value of resolveStaticValues(info, expression, scope, options.resolving)) {
      if (value.kind === "node" && isCallableNode(value.node)) {
        visitCallableNode(value.info, value.node, value.declarationScope, state, options);
      } else if (value.kind === "convexFunction") {
        visitConvexFunction(value, state);
      } else if (value.kind === "resourceCreatorBootstrap") {
        visitResourceCreatorBootstrap(value);
      }
    }
  };

  const visitBlock = (
    info: CheckerSourceFile,
    block: ts.Block,
    parentScope: LexicalScope,
    state: AuthorityState,
  ): void => {
    const scope: LexicalScope = {
      parent: parentScope,
      bindings: new Map(),
    };
    collectDirectBlockBindings(block, scope);
    for (const statement of block.statements) {
      if (ts.isFunctionDeclaration(statement)) continue;
      visitReachable(info, statement, scope, state);
    }
  };

  function invalidateMutationTarget(
    info: CheckerSourceFile,
    target: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    preserveDirectAssignment: boolean,
  ): void {
    const bindings = new Set<ScopedBinding>();
    collectMutationTargetBindings(info, target, scope, bindings);
    const unwrappedTarget = unwrapExpression(target);
    const directAssignmentBinding =
      preserveDirectAssignment && ts.isIdentifier(unwrappedTarget)
        ? findAnyBinding(info, scope, unwrappedTarget.text)
        : null;

    for (const binding of bindings) {
      state.publicArgsBindings.delete(binding);
      state.checkedTokenBindings.delete(binding);
      state.checkedIdentityTokenBindings.delete(binding);
      if (binding === directAssignmentBinding) {
        state.ctxBindings.delete(binding);
      } else {
        binding.value = { kind: "unknown" };
      }
    }
  }

  function collectMutationTargetBindings(
    info: CheckerSourceFile,
    target: ts.Expression,
    scope: LexicalScope | null,
    bindings: Set<ScopedBinding>,
  ): void {
    const unwrappedTarget = unwrapExpression(target);
    if (ts.isIdentifier(unwrappedTarget)) {
      const binding = findAnyBinding(info, scope, unwrappedTarget.text);
      if (binding) bindings.add(binding);
      return;
    }
    if (
      ts.isPropertyAccessExpression(unwrappedTarget) ||
      ts.isElementAccessExpression(unwrappedTarget)
    ) {
      collectMutationTargetBindings(info, unwrappedTarget.expression, scope, bindings);
      return;
    }
    if (ts.isArrayLiteralExpression(unwrappedTarget)) {
      for (const element of unwrappedTarget.elements) {
        if (ts.isOmittedExpression(element)) continue;
        collectMutationTargetBindings(
          info,
          ts.isSpreadElement(element) ? element.expression : element,
          scope,
          bindings,
        );
      }
      return;
    }
    if (ts.isObjectLiteralExpression(unwrappedTarget)) {
      for (const property of unwrappedTarget.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          collectMutationTargetBindings(info, property.name, scope, bindings);
        } else if (ts.isPropertyAssignment(property)) {
          collectMutationTargetBindings(info, property.initializer, scope, bindings);
        } else if (ts.isSpreadAssignment(property)) {
          collectMutationTargetBindings(info, property.expression, scope, bindings);
        }
      }
      return;
    }
    if (
      ts.isBinaryExpression(unwrappedTarget) &&
      unwrappedTarget.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      collectMutationTargetBindings(info, unwrappedTarget.left, scope, bindings);
    }
  }

  const visitReachable = (
    info: CheckerSourceFile,
    node: ts.Node,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void => {
    if (isCallableNode(node)) return;

    if (ts.isIfStatement(node)) {
      visitReachable(info, node.expression, scope, state);
      const before = snapshotBindingValues(scope);
      const beforeAuthority = snapshotAuthorityState(state);
      const thenState = cloneAuthorityState(state);
      for (const expression of truthyPresenceExpressions(node.expression)) {
        addPresenceCheck(info, expression, scope, thenState);
      }
      visitReachable(info, node.thenStatement, scope, thenState);
      const afterThen = snapshotBindingValues(scope);
      restoreBindingValues(before);
      const elseState = cloneAuthorityState(beforeAuthority);
      for (const expression of falsyPresenceExpressions(node.expression)) {
        addPresenceCheck(info, expression, scope, elseState);
      }
      if (node.elseStatement) {
        visitReachable(info, node.elseStatement, scope, elseState);
      }
      const afterElse = snapshotBindingValues(scope);
      const continuingBindings: BindingSnapshot[] = [];
      const continuingAuthority: AuthorityState[] = [];
      if (statementCanFallThrough(node.thenStatement)) {
        continuingBindings.push(afterThen);
        continuingAuthority.push(thenState);
      }
      if (!node.elseStatement || statementCanFallThrough(node.elseStatement)) {
        continuingBindings.push(afterElse);
        continuingAuthority.push(elseState);
      }
      if (continuingBindings.length > 0) {
        mergeBindingValues(before, continuingBindings);
      } else {
        restoreBindingValues(before);
      }
      if (continuingAuthority.length === 1) {
        restoreAuthorityState(state, continuingAuthority[0]!);
      } else {
        restoreAuthorityState(
          state,
          conservativelyMergeAuthorityStates(beforeAuthority, continuingAuthority),
        );
      }
      return;
    }

    if (ts.isBlock(node)) {
      visitBlock(info, node, scope ?? { parent: null, bindings: new Map() }, state);
      return;
    }

    if (ts.isForStatement(node)) {
      const before = snapshotBindingValues(scope);
      const beforeAuthority = snapshotAuthorityState(state);
      const loopScope = createChildScope(scope);
      if (node.initializer) {
        collectForInitializerBindings(node.initializer, loopScope);
        visitReachable(info, node.initializer, loopScope, state);
      }
      if (node.condition) visitReachable(info, node.condition, loopScope, state);
      visitReachable(info, node.statement, loopScope, state);
      if (node.incrementor) {
        visitReachable(info, node.incrementor, loopScope, state);
      }
      const afterAuthority = snapshotAuthorityState(state);
      restoreBindingValues(before);
      restoreAuthorityState(
        state,
        conservativelyMergeAuthorityStates(beforeAuthority, [afterAuthority]),
      );
      return;
    }

    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const before = snapshotBindingValues(scope);
      const beforeAuthority = snapshotAuthorityState(state);
      const loopScope = createChildScope(scope);
      collectForInitializerBindings(node.initializer, loopScope);
      visitReachable(info, node.initializer, loopScope, state);
      visitReachable(info, node.expression, loopScope, state);
      visitReachable(info, node.statement, loopScope, state);
      const afterAuthority = snapshotAuthorityState(state);
      restoreBindingValues(before);
      restoreAuthorityState(
        state,
        conservativelyMergeAuthorityStates(beforeAuthority, [afterAuthority]),
      );
      return;
    }

    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      const before = snapshotBindingValues(scope);
      const beforeAuthority = snapshotAuthorityState(state);
      visitReachable(info, node.expression, scope, state);
      visitReachable(info, node.statement, scope, state);
      const afterAuthority = snapshotAuthorityState(state);
      restoreBindingValues(before);
      restoreAuthorityState(
        state,
        conservativelyMergeAuthorityStates(beforeAuthority, [afterAuthority]),
      );
      return;
    }

    if (ts.isCatchClause(node)) {
      const catchScope = createChildScope(scope);
      if (node.variableDeclaration) {
        addBindingNames(
          catchScope,
          node.variableDeclaration.name,
          node.variableDeclaration,
          catchScope,
        );
      }
      visitReachable(info, node.block, catchScope, state);
      return;
    }

    if (ts.isCaseBlock(node)) {
      const before = snapshotBindingValues(scope);
      const beforeAuthority = snapshotAuthorityState(state);
      const switchScope = createChildScope(scope);
      collectDirectCaseBlockBindings(node, switchScope);
      for (const clause of node.clauses) {
        if (ts.isCaseClause(clause)) {
          visitReachable(info, clause.expression, switchScope, state);
        }
        for (const statement of clause.statements) {
          visitReachable(info, statement, switchScope, state);
        }
      }
      const afterAuthority = snapshotAuthorityState(state);
      restoreBindingValues(before);
      restoreAuthorityState(
        state,
        conservativelyMergeAuthorityStates(beforeAuthority, [afterAuthority]),
      );
      return;
    }

    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      visitReachable(info, node.right, scope, state);
      visitReachable(info, node.left, scope, state);
      invalidateMutationTarget(
        info,
        node.left,
        scope,
        state,
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken,
      );
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        assignBindingExpression(node.left, node.right, scope);
      }
      return;
    }

    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      visitReachable(info, node.operand, scope, state);
      invalidateMutationTarget(info, node.operand, scope, state, false);
      return;
    }

    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(unwrapExpression(node.expression)) ||
        ts.isElementAccessExpression(unwrapExpression(node.expression)))
    ) {
      visitReachable(info, node.expression, scope, state);
      invalidateMutationTarget(info, node.expression, scope, state, false);
      return;
    }

    if (ts.isCallExpression(node)) {
      const target = unwrapExpression(node.expression);
      if (isSdkIamCallTarget(info, target, scope)) {
        validateSdkIamCall(info, node, scope, state);
      }
      validateDefaultTenantHelperCall(info, node, scope);
      if (state.trackPublicArgs) {
        const iamAuthorizationCallKind = iamAuthorizationCallTargetKind(info, target, scope);
        if (iamAuthorizationCallKind === "checkPermissions") {
          validateCheckPermissionsCall(info, node, scope, state);
        } else if (iamAuthorizationCallKind === "authorizationObject") {
          validateAuthorizationObjectArgumentCall(info, node, scope, state);
        }
      }
      visitRunActionTarget(info, node, scope, state);
      visitCallableReference(info, target, scope, state, {
        callArguments: [...node.arguments],
        callInfo: info,
        callScope: scope,
      });
      visitReachable(info, target, scope, state);
      for (const argument of node.arguments) {
        // Do not infer whether an arbitrary higher-order callee invokes a
        // callback. A statically visible IAM SDK caller passed from an exposed
        // handler is itself authority exposure, so classify callable arguments
        // syntactically and still inspect the argument expression.
        visitCallableReference(info, argument, scope, state);
        visitReachable(info, argument, scope, state);
      }
      return;
    }

    ts.forEachChild(node, (child) => visitReachable(info, child, scope, state));
  };

  const collectAuthorityRoots = (
    info: CheckerSourceFile,
  ): Array<Extract<StaticValue, { kind: "convexFunction" | "resourceCreatorBootstrap" }>> => {
    const roots: Array<
      Extract<StaticValue, { kind: "convexFunction" | "resourceCreatorBootstrap" }>
    > = [];
    const exportedNames = collectExportedNames(info.sourceFile);
    const addRoot = (expression: ts.Expression): void => {
      for (const value of resolveStaticValues(info, expression, null)) {
        if (value.kind === "convexFunction" || value.kind === "resourceCreatorBootstrap") {
          roots.push(value);
        }
      }
    };

    for (const statement of info.sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        const isDirectExport = hasExportModifier(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            (isDirectExport || exportedNames.has(declaration.name.text))
          ) {
            addRoot(declaration.initializer);
          }
        }
      } else if (ts.isExportAssignment(statement)) {
        addRoot(statement.expression);
      }
    }
    return roots;
  };

  const visitFactoryArguments = (
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void => {
    for (const argument of call.arguments) {
      visitReachable(info, argument, scope, state);
      for (const value of resolveStaticValues(info, argument, scope)) {
        if (value.kind === "node" && ts.isObjectLiteralExpression(value.node)) {
          visitConfigObject(value.info, value.node, value.declarationScope, state);
        }
      }
    }
  };

  const visitConvexFunction = (
    root: Extract<StaticValue, { kind: "convexFunction" }>,
    state: AuthorityState,
  ): void => {
    const rootKey = `${root.info.filePath}:${root.call.getStart(root.info.sourceFile)}:${
      root.builder
    }:${state.mode}`;
    if (visitedConvexFunctions.has(rootKey)) return;
    visitedConvexFunctions.add(rootKey);

    visitFactoryArguments(root.info, root.call, root.declarationScope, state);
  };

  const visitResourceCreatorBootstrap = (
    root: Extract<StaticValue, { kind: "resourceCreatorBootstrap" }>,
  ): void => {
    const rootKey = `${root.info.filePath}:${root.call.getStart(root.info.sourceFile)}`;
    if (visitedResourceCreatorBootstraps.has(rootKey)) return;
    visitedResourceCreatorBootstraps.add(rootKey);
    validateResourceCreatorBootstrap(root);
    visitFactoryArguments(
      root.info,
      root.call,
      root.declarationScope,
      createAuthorityState("reject"),
    );
  };

  function validateResourceCreatorBootstrap(
    root: Extract<StaticValue, { kind: "resourceCreatorBootstrap" }>,
  ): void {
    if (!iamCatalog) return;
    const configArgument = root.call.arguments[0];
    if (!configArgument) return;
    const configValues = resolveStaticValues(
      root.info,
      configArgument,
      root.declarationScope,
    ).filter(
      (value): value is Extract<StaticValue, { kind: "node" }> =>
        value.kind === "node" && ts.isObjectLiteralExpression(value.node),
    );
    if (configValues.length !== 1) return;
    const config = configValues[0]!;
    const configObject = config.node as ts.ObjectLiteralExpression;
    if (objectHasDynamicSpread(config.info, configObject, config.declarationScope)) return;

    const resourceType = literalStringProperty(
      config.info,
      configObject,
      "resourceType",
      config.declarationScope,
    );
    const managerRole = deterministicObjectProperty(
      config.info,
      configObject,
      "managerRole",
      config.declarationScope,
      new Set(),
    );
    if (!resourceType || managerRole.kind !== "found") return;

    const roleReference = literalRoleReference(
      managerRole.info,
      managerRole.expression,
      managerRole.scope,
    );
    if (!roleReference) return;

    const roleResolution = resolveCatalogRole(iamCatalog, roleReference);
    if (roleResolution.kind !== "resolved") return;

    const appliesTo =
      literalStringProperty(config.info, configObject, "appliesTo", config.declarationScope)
        ?.value ?? null;
    const validation = validateBootstrapRoleForResource(
      iamCatalog,
      roleResolution.role,
      resourceType.value,
      appliesTo,
    );
    if (!validation) return;
    addBootstrapFinding(
      roleReference.info,
      roleReference.node,
      `Creator bootstrap role "${roleResolution.role.key}" cannot be granted on "${resourceType.value}": ${validation}.`,
    );
  }

  function literalStringProperty(
    info: CheckerSourceFile,
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
    scope: LexicalScope | null,
  ): { value: string; node: ts.Node } | null {
    const property = deterministicObjectProperty(
      info,
      objectLiteral,
      propertyName,
      scope,
      new Set(),
    );
    if (property.kind !== "found") return null;
    const expression = unwrapExpression(property.expression);
    return ts.isStringLiteralLike(expression) ? { value: expression.text, node: expression } : null;
  }

  function literalRoleReference(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
  ): {
    kind: "key" | "id";
    value: string;
    description: string;
    info: CheckerSourceFile;
    node: ts.Node;
  } | null {
    const values = resolveStaticValues(info, expression, scope).filter(
      (value): value is Extract<StaticValue, { kind: "node" }> =>
        value.kind === "node" && ts.isObjectLiteralExpression(value.node),
    );
    if (values.length !== 1) return null;
    const value = values[0]!;
    const objectLiteral = value.node as ts.ObjectLiteralExpression;
    if (objectHasDynamicSpread(value.info, objectLiteral, value.declarationScope)) return null;
    const key = literalStringProperty(value.info, objectLiteral, "key", value.declarationScope);
    if (key) {
      return {
        kind: "key",
        value: key.value,
        description: `"${key.value}"`,
        info: value.info,
        node: key.node,
      };
    }
    const id = literalStringProperty(value.info, objectLiteral, "id", value.declarationScope);
    if (!id) return null;
    return {
      kind: "id",
      value: id.value,
      description: `id "${id.value}"`,
      info: value.info,
      node: id.node,
    };
  }

  const visitConfigObject = (
    info: CheckerSourceFile,
    config: ts.ObjectLiteralExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
    visitedProperties: Set<string> = new Set(),
  ): void => {
    for (let index = config.properties.length - 1; index >= 0; index -= 1) {
      const property = config.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
        visitReachable(info, property.expression, scope, state);
        const objectValues = resolveStaticValues(info, property.expression, scope).filter(
          (value): value is Extract<StaticValue, { kind: "node" }> =>
            value.kind === "node" && ts.isObjectLiteralExpression(value.node),
        );
        if (objectValues.length === 1) {
          const value = objectValues[0]!;
          visitConfigObject(
            value.info,
            value.node as ts.ObjectLiteralExpression,
            value.declarationScope,
            state,
            visitedProperties,
          );
        }
        continue;
      }
      if (property.name && ts.isComputedPropertyName(property.name)) {
        visitReachable(info, property.name.expression, scope, state);
      }
      const propertyName =
        property.name &&
        (ts.isIdentifier(property.name) ||
          ts.isStringLiteralLike(property.name) ||
          ts.isNumericLiteral(property.name))
          ? property.name.text
          : null;
      if (propertyName && visitedProperties.has(propertyName)) {
        continue;
      }
      if (propertyName) {
        visitedProperties.add(propertyName);
      }
      if (ts.isMethodDeclaration(property)) {
        visitCallableNode(info, property, scope, state, {
          markFirstParameterAsCtx: propertyName === "handler",
        });
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        visitCallableReference(info, property.name, scope, state, {
          markFirstParameterAsCtx: property.name.text === "handler",
        });
        visitReachable(info, property, scope, state);
        continue;
      }
      if (!ts.isPropertyAssignment(property)) {
        visitReachable(info, property, scope, state);
        continue;
      }
      const initializer = unwrapExpression(property.initializer);
      if (state.trackPublicArgs && propertyName === "tenant") {
        validateAuthorizationProvider(info, initializer, scope, state);
      }
      visitCallableReference(info, initializer, scope, state, {
        markFirstParameterAsCtx: propertyName === "handler",
      });
      visitReachable(info, initializer, scope, state);
    }
  };

  function visitRunActionTarget(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const target = unwrapExpression(call.expression);
    if (
      !ts.isPropertyAccessExpression(target) ||
      target.name.text !== "runAction" ||
      call.arguments.length === 0
    ) {
      return;
    }

    const nextMode = state.mode === "service" ? "service" : "reject";
    for (const value of resolveInternalApiReferenceValues(call.arguments[0]!, info, scope)) {
      if (value.kind === "convexFunction") {
        visitConvexFunction(value, createAuthorityState(nextMode));
      }
    }
  }

  function isSdkIamCallTarget(
    info: CheckerSourceFile,
    target: ts.Expression,
    scope: LexicalScope | null,
  ): boolean {
    return resolveStaticValues(info, target, scope).some(
      (value) => value.kind === "known" && value.value === "herculesSdkIam",
    );
  }

  function validateSdkIamCall(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    if (state.mode === "reject") {
      addFinding(info, call, state);
      return;
    }

    const payload = sdkIamPayloadArgument(info, call, scope);
    if (!payload) {
      addFinding(info, call, state);
      return;
    }

    if (state.mode === "service") {
      if (unwrapExpression(payload.property.expression).kind === ts.SyntaxKind.NullKeyword) {
        return;
      }
      addFinding(info, call, state);
      return;
    }

    if (
      isVerifiedActorTokenIdentifier(
        payload.property.info,
        payload.property.expression,
        payload.property.scope,
        state,
        new Set(),
      )
    ) {
      return;
    }
    addFinding(info, call, state);
  }

  function sdkIamPayloadArgument(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
  ): {
    property: {
      info: CheckerSourceFile;
      expression: ts.Expression;
      scope: LexicalScope | null;
    };
  } | null {
    const argumentsList = sdkIamMethodArguments(info, call, scope);
    if (!argumentsList) return null;

    const candidates: Array<{
      index: number;
      property: {
        info: CheckerSourceFile;
        expression: ts.Expression;
        scope: LexicalScope | null;
      };
    }> = [];
    const unresolvedArgumentIndexes: number[] = [];
    let invalidPayloadShape = false;

    argumentsList.forEach((argument, index) => {
      const values = resolveStaticValues(argument.info, argument.expression, argument.scope);
      const objectValues = values.filter(
        (value): value is Extract<StaticValue, { kind: "node" }> =>
          value.kind === "node" && ts.isObjectLiteralExpression(value.node),
      );
      if (objectValues.length === 0) {
        if (values.length === 0) unresolvedArgumentIndexes.push(index);
        return;
      }
      if (values.length !== 1 || objectValues.length !== 1) {
        invalidPayloadShape = true;
        return;
      }

      const objectValue = objectValues[0]!;
      const objectLiteral = objectValue.node as ts.ObjectLiteralExpression;
      if (objectHasDynamicSpread(objectValue.info, objectLiteral, objectValue.declarationScope)) {
        invalidPayloadShape = true;
        return;
      }

      const property = deterministicObjectProperty(
        objectValue.info,
        objectLiteral,
        "actor_token_identifier",
        objectValue.declarationScope,
        new Set(),
      );
      if (property.kind === "dynamic") {
        invalidPayloadShape = true;
      } else if (property.kind === "found") {
        candidates.push({ index, property });
      }
    });

    if (invalidPayloadShape || candidates.length !== 1) return null;
    const candidate = candidates[0]!;
    if (unresolvedArgumentIndexes.some((index) => index > candidate.index)) {
      return null;
    }
    return { property: candidate.property };
  }

  function sdkIamMethodArguments(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
  ): Array<{
    info: CheckerSourceFile;
    expression: ts.Expression;
    scope: LexicalScope | null;
  }> | null {
    const target = unwrapExpression(call.expression);
    if (ts.isPropertyAccessExpression(target) && target.name.text === "call") {
      return call.arguments.slice(1).map((expression) => ({ info, expression, scope }));
    }
    if (ts.isPropertyAccessExpression(target) && target.name.text === "apply") {
      const argumentList = call.arguments[1];
      if (!argumentList) return null;
      const values = resolveStaticValues(info, argumentList, scope);
      if (values.length !== 1) return null;
      const value = values[0]!;
      if (value.kind !== "node" || !ts.isArrayLiteralExpression(value.node)) return null;
      const argumentsArray: Array<{
        info: CheckerSourceFile;
        expression: ts.Expression;
        scope: LexicalScope | null;
      }> = [];
      for (const element of value.node.elements) {
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return null;
        argumentsArray.push({
          info: value.info,
          expression: element,
          scope: value.declarationScope,
        });
      }
      return argumentsArray;
    }
    return call.arguments.map((expression) => ({ info, expression, scope }));
  }

  function deterministicObjectProperty(
    info: CheckerSourceFile,
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
    scope: LexicalScope | null,
    resolving: Set<string>,
  ):
    | {
        kind: "found";
        info: CheckerSourceFile;
        expression: ts.Expression;
        scope: LexicalScope | null;
      }
    | { kind: "missing" }
    | { kind: "dynamic" } {
    for (let index = objectLiteral.properties.length - 1; index >= 0; index -= 1) {
      const property = objectLiteral.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
        const objectValues = resolveStaticValues(
          info,
          property.expression,
          scope,
          resolving,
        ).filter(
          (value): value is Extract<StaticValue, { kind: "node" }> =>
            value.kind === "node" && ts.isObjectLiteralExpression(value.node),
        );
        if (objectValues.length !== 1) return { kind: "dynamic" };
        const spreadValue = objectValues[0]!;
        const spreadProperty = deterministicObjectProperty(
          spreadValue.info,
          spreadValue.node as ts.ObjectLiteralExpression,
          propertyName,
          spreadValue.declarationScope,
          resolving,
        );
        if (spreadProperty.kind !== "missing") return spreadProperty;
        continue;
      }
      const name = property.name;
      const nameText =
        name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null;
      if (nameText !== propertyName) continue;
      if (ts.isPropertyAssignment(property)) {
        return {
          kind: "found",
          info,
          expression: property.initializer,
          scope,
        };
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        return {
          kind: "found",
          info,
          expression: property.name,
          scope,
        };
      }
      return { kind: "dynamic" };
    }
    return { kind: "missing" };
  }

  function objectHasDynamicSpread(
    info: CheckerSourceFile,
    objectLiteral: ts.ObjectLiteralExpression,
    scope: LexicalScope | null,
    resolving: Set<string> = new Set(),
  ): boolean {
    for (const property of objectLiteral.properties) {
      if (!ts.isSpreadAssignment(property)) continue;
      const objectValues = resolveStaticValues(info, property.expression, scope, resolving).filter(
        (value): value is Extract<StaticValue, { kind: "node" }> =>
          value.kind === "node" && ts.isObjectLiteralExpression(value.node),
      );
      if (objectValues.length !== 1) return true;
      const value = objectValues[0]!;
      if (
        objectHasDynamicSpread(
          value.info,
          value.node as ts.ObjectLiteralExpression,
          value.declarationScope,
          resolving,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function isDirectPublicArgsValue(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    resolving: Set<string>,
  ): boolean {
    const target = unwrapExpression(expression);
    if (ts.isIdentifier(target)) {
      const binding = findAnyBinding(info, scope, target.text);
      if (!binding) return false;
      if (state.publicArgsBindings.has(binding)) return true;
      if (binding.value.kind !== "expression") return false;
      const bindingKey = `${info.filePath}:public-args:${binding.id}`;
      if (resolving.has(bindingKey)) return false;
      const expressionInfo = binding.value.expressionInfo ?? info;
      return isDirectPublicArgsValue(
        expressionInfo,
        binding.value.expression,
        binding.value.scope,
        state,
        new Set(resolving).add(bindingKey),
      );
    }

    if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
      return isDirectPublicArgsValue(info, target.expression, scope, state, resolving);
    }

    return false;
  }

  function containsDirectPublicArgsValue(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    resolving: Set<string> = new Set(),
  ): boolean {
    const target = unwrapExpression(expression);
    if (isDirectPublicArgsValue(info, target, scope, state, resolving)) return true;

    if (ts.isArrayLiteralExpression(target)) {
      return target.elements.some((element) => {
        if (ts.isOmittedExpression(element)) return false;
        return containsDirectPublicArgsValue(
          info,
          ts.isSpreadElement(element) ? element.expression : element,
          scope,
          state,
          resolving,
        );
      });
    }

    if (ts.isObjectLiteralExpression(target)) {
      return target.properties.some((property) => {
        if (ts.isSpreadAssignment(property)) {
          return containsDirectPublicArgsValue(info, property.expression, scope, state, resolving);
        }
        if (ts.isPropertyAssignment(property)) {
          return (
            (property.name &&
              ts.isComputedPropertyName(property.name) &&
              containsDirectPublicArgsValue(
                info,
                property.name.expression,
                scope,
                state,
                resolving,
              )) ||
            containsDirectPublicArgsValue(info, property.initializer, scope, state, resolving)
          );
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          return containsDirectPublicArgsValue(info, property.name, scope, state, resolving);
        }
        return false;
      });
    }

    return false;
  }

  type AuthorizationObjectValidationOptions = {
    validatePermission?: boolean;
  };

  function validateAuthorizationObject(
    info: CheckerSourceFile,
    objectLiteral: ts.ObjectLiteralExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
    options: AuthorizationObjectValidationOptions = {},
  ): void {
    if (options.validatePermission === true) {
      validateAuthorizationObjectPermission(info, objectLiteral, scope, state);
    }

    validateAuthorizationObjectResourceType(info, objectLiteral, scope, state, [
      "resourceType",
      "resource_type",
    ]);

    const ancestors = deterministicObjectProperty(
      info,
      objectLiteral,
      "ancestors",
      scope,
      new Set(),
    );
    if (
      ancestors.kind === "found" &&
      containsDirectPublicArgsValue(ancestors.info, ancestors.expression, ancestors.scope, state)
    ) {
      addAuthorizationArgsFinding(ancestors.info, ancestors.expression, "ancestors");
    }

    const resource = deterministicObjectProperty(info, objectLiteral, "resource", scope, new Set());
    if (resource.kind !== "found") return;
    if (
      isDirectPublicArgsValue(resource.info, resource.expression, resource.scope, state, new Set())
    ) {
      addAuthorizationArgsFinding(resource.info, resource.expression, "resource type");
    }
    for (const value of resolveStaticValues(resource.info, resource.expression, resource.scope)) {
      if (value.kind === "node" && ts.isObjectLiteralExpression(value.node)) {
        validateAuthorizationObjectResourceType(
          value.info,
          value.node,
          value.declarationScope,
          state,
          ["type", "resourceType"],
        );
      }
    }
  }

  function validateAuthorizationObjectPermission(
    info: CheckerSourceFile,
    objectLiteral: ts.ObjectLiteralExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const permission = deterministicObjectProperty(
      info,
      objectLiteral,
      "permission",
      scope,
      new Set(),
    );
    if (
      permission.kind === "found" &&
      isDirectPublicArgsValue(
        permission.info,
        permission.expression,
        permission.scope,
        state,
        new Set(),
      )
    ) {
      addAuthorizationArgsFinding(permission.info, permission.expression, "permission");
    }

    const permissions = deterministicObjectProperty(
      info,
      objectLiteral,
      "permissions",
      scope,
      new Set(),
    );
    if (
      permissions.kind === "found" &&
      containsDirectPublicArgsValue(
        permissions.info,
        permissions.expression,
        permissions.scope,
        state,
      )
    ) {
      addAuthorizationArgsFinding(permissions.info, permissions.expression, "permission");
    }
  }

  function validateAuthorizationObjectResourceType(
    info: CheckerSourceFile,
    objectLiteral: ts.ObjectLiteralExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
    propertyNames: string[],
  ): void {
    for (const propertyName of propertyNames) {
      const property = deterministicObjectProperty(
        info,
        objectLiteral,
        propertyName,
        scope,
        new Set(),
      );
      if (
        property.kind === "found" &&
        isDirectPublicArgsValue(
          property.info,
          property.expression,
          property.scope,
          state,
          new Set(),
        )
      ) {
        addAuthorizationArgsFinding(property.info, property.expression, "resource type");
      }
    }
  }

  function validateCheckPermissionsCall(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const requests = call.arguments[1];
    if (!requests) return;
    for (const value of resolveStaticValues(info, requests, scope)) {
      if (value.kind !== "node") continue;
      if (ts.isArrayLiteralExpression(value.node)) {
        for (const element of value.node.elements) {
          if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) continue;
          validateAuthorizationRequestExpression(
            value.info,
            element,
            value.declarationScope,
            state,
            { validatePermission: true },
          );
        }
      } else if (ts.isObjectLiteralExpression(value.node)) {
        validateAuthorizationObject(value.info, value.node, value.declarationScope, state, {
          validatePermission: true,
        });
      }
    }
  }

  function validateDefaultTenantHelperCall(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
  ): void {
    const argumentKind = defaultTenantHelperArgumentKind(
      info,
      unwrapExpression(call.expression),
      scope,
    );
    const request = call.arguments[1];
    if (!argumentKind || !request) return;

    if (argumentKind === "object") {
      validateDefaultTenantRequest(info, request, scope);
      return;
    }

    for (const value of resolveStaticValues(info, request, scope)) {
      if (value.kind !== "node" || !ts.isArrayLiteralExpression(value.node)) continue;
      for (const element of value.node.elements) {
        if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) continue;
        validateDefaultTenantRequest(value.info, element, value.declarationScope);
      }
    }
  }

  function validateDefaultTenantRequest(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
  ): void {
    for (const value of resolveStaticValues(info, expression, scope)) {
      if (value.kind !== "node" || !ts.isObjectLiteralExpression(value.node)) continue;
      const tenantId = deterministicObjectProperty(
        value.info,
        value.node,
        "tenantId",
        value.declarationScope,
        new Set(),
      );
      if (
        tenantId.kind === "found" &&
        isDefaultTenantLiteral(tenantId.info, tenantId.expression, tenantId.scope, new Set())
      ) {
        addInvalidDefaultTenantLiteralFinding(tenantId.info, tenantId.expression);
      }
    }
  }

  function isDefaultTenantLiteral(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    resolving: Set<string>,
  ): boolean {
    const value = unwrapExpression(expression);
    if (ts.isStringLiteralLike(value)) {
      return value.text === "default";
    }
    if (!ts.isIdentifier(value)) return false;

    const binding = findAnyBinding(info, scope, value.text);
    if (!binding || binding.value.kind !== "expression") return false;
    if (binding.value.propertyPath.length > 0) return false;
    const bindingKey = `${info.filePath}:default-tenant-binding:${binding.id}`;
    if (resolving.has(bindingKey)) return false;
    const expressionInfo = binding.value.expressionInfo ?? info;
    return isDefaultTenantLiteral(
      expressionInfo,
      binding.value.expression,
      binding.value.scope,
      new Set(resolving).add(bindingKey),
    );
  }

  function defaultTenantHelperArgumentKind(
    info: CheckerSourceFile,
    target: ts.Expression,
    scope: LexicalScope | null,
  ): "object" | "checks" | null {
    const kinds = new Set<"object" | "checks">();
    for (const value of resolveStaticValues(info, target, scope)) {
      if (value.kind !== "known") continue;
      if (value.value === "iamCheckPermissions") {
        kinds.add("checks");
      } else if (
        value.value === "iamAuthorizationRequestFunction" ||
        value.value === "iamResourceSharingRecipientsFunction" ||
        value.value === "iamDefaultTenantObjectFunction"
      ) {
        kinds.add("object");
      }
    }
    return kinds.size === 1 ? [...kinds][0]! : null;
  }

  function validateAuthorizationRequestExpression(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    options: AuthorizationObjectValidationOptions = {},
  ): void {
    for (const value of resolveStaticValues(info, expression, scope)) {
      if (value.kind === "node" && ts.isObjectLiteralExpression(value.node)) {
        validateAuthorizationObject(value.info, value.node, value.declarationScope, state, options);
      }
    }
  }

  function validateAuthorizationObjectArgumentCall(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const request = call.arguments[1];
    if (request) {
      validateAuthorizationRequestExpression(info, request, scope, state, {
        validatePermission: true,
      });
    }
  }

  function iamAuthorizationCallTargetKind(
    info: CheckerSourceFile,
    target: ts.Expression,
    scope: LexicalScope | null,
  ): "checkPermissions" | "authorizationObject" | null {
    const kinds = new Set<"checkPermissions" | "authorizationObject">();
    for (const value of resolveStaticValues(info, target, scope)) {
      if (value.kind !== "known") continue;
      if (value.value === "iamCheckPermissions") {
        kinds.add("checkPermissions");
      } else if (
        value.value === "iamAuthorizationRequestFunction" ||
        value.value === "iamResourceSharingRecipientsFunction"
      ) {
        kinds.add("authorizationObject");
      }
    }
    return kinds.size === 1 ? [...kinds][0]! : null;
  }

  function validateAuthorizationProvider(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    scanTenantAuthorizationHelpers(info, expression, scope, state);
    for (const value of resolveStaticValues(info, expression, scope)) {
      if (value.kind === "node" && ts.isObjectLiteralExpression(value.node)) {
        validateAuthorizationObject(value.info, value.node, value.declarationScope, state);
      } else if (value.kind === "node" && isCallableNode(value.node)) {
        validateAuthorizationProviderCallable(
          value.info,
          value.node,
          value.declarationScope,
          state,
        );
      }
    }
  }

  function validateAuthorizationProviderCallable(
    info: CheckerSourceFile,
    node: ts.FunctionLikeDeclaration,
    declarationScope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const key = `${info.filePath}:authorization-provider:${node.getStart(info.sourceFile)}`;
    if (visitedAuthorizationProviders.has(key)) return;
    visitedAuthorizationProviders.add(key);
    if (!node.body) return;

    const functionScope = createChildScope(declarationScope);
    const functionState = cloneAuthorityState(state);
    node.parameters.forEach((parameter, index) => {
      addBindingNames(functionScope, parameter.name, parameter, functionScope);
      if (state.trackPublicArgs && index === 1) {
        for (const name of collectBindingNames(parameter.name)) {
          const binding = functionScope.bindings.get(name);
          if (binding) functionState.publicArgsBindings.add(binding);
        }
      }
    });

    validateCallableAuthorizationReturns(info, node.body, functionScope, functionState, (expr) => {
      validateAuthorizationProvider(info, expr, functionScope, functionState);
    });
  }

  function validateAuthorizeAgainstProvider(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    if (containsDirectPublicArgsValue(info, expression, scope, state)) {
      addAuthorizationArgsFinding(info, expression, "ancestors");
      return;
    }
    for (const value of resolveStaticValues(info, expression, scope)) {
      if (value.kind === "node" && isCallableNode(value.node) && value.node.body) {
        const functionScope = createChildScope(value.declarationScope);
        for (const parameter of value.node.parameters) {
          addBindingNames(functionScope, parameter.name, parameter, functionScope);
        }
        validateCallableAuthorizationReturns(
          value.info,
          value.node.body,
          functionScope,
          state,
          (expr) => {
            if (containsDirectPublicArgsValue(value.info, expr, functionScope, state)) {
              addAuthorizationArgsFinding(value.info, expr, "ancestors");
            }
          },
        );
      }
    }
  }

  function validateCallableAuthorizationReturns(
    info: CheckerSourceFile,
    body: ts.ConciseBody,
    functionScope: LexicalScope,
    state: AuthorityState,
    validateReturn: (expression: ts.Expression) => void,
  ): void {
    if (!ts.isBlock(body)) {
      validateReturn(body);
      return;
    }

    const blockScope = createChildScope(functionScope);
    collectDirectBlockBindings(body, blockScope);
    for (const statement of body.statements) {
      if (ts.isFunctionDeclaration(statement)) continue;
      if (ts.isReturnStatement(statement)) {
        if (statement.expression) validateReturn(statement.expression);
        continue;
      }
      visitReachable(info, statement, blockScope, state);
    }
  }

  function scanTenantAuthorizationHelpers(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        validateTenantAuthorizationHelperCall(info, node, scope, state);
      }
      if (isCallableNode(node)) return;
      ts.forEachChild(node, visit);
    };
    visit(expression);
  }

  function validateTenantAuthorizationHelperCall(
    info: CheckerSourceFile,
    call: ts.CallExpression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const target = unwrapExpression(call.expression);
    const helperName = tenantAuthorizationHelperName(info, target, scope);
    if (!helperName) return;
    const options = call.arguments[2];
    if (!options) return;
    for (const value of resolveStaticValues(info, options, scope)) {
      if (value.kind !== "node" || !ts.isObjectLiteralExpression(value.node)) continue;
      if (
        (helperName === "tenantFromParentResource" ||
          helperName === "tenantFromDefaultParentResource") &&
        deterministicObjectProperty(
          value.info,
          value.node,
          "parentResourceType",
          value.declarationScope,
          new Set(),
        ).kind === "found"
      ) {
        const parentResourceType = deterministicObjectProperty(
          value.info,
          value.node,
          "parentResourceType",
          value.declarationScope,
          new Set(),
        );
        if (
          parentResourceType.kind === "found" &&
          isDirectPublicArgsValue(
            parentResourceType.info,
            parentResourceType.expression,
            parentResourceType.scope,
            state,
            new Set(),
          )
        ) {
          addAuthorizationArgsFinding(
            parentResourceType.info,
            parentResourceType.expression,
            "resource type",
          );
        }
      }
      const authorizeAgainst = deterministicObjectProperty(
        value.info,
        value.node,
        "authorizeAgainst",
        value.declarationScope,
        new Set(),
      );
      if (authorizeAgainst.kind === "found") {
        validateAuthorizeAgainstProvider(
          authorizeAgainst.info,
          authorizeAgainst.expression,
          authorizeAgainst.scope,
          state,
        );
      }
    }
  }

  function tenantAuthorizationHelperName(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
  ): TenantResourceHelperName | null {
    for (const value of resolveStaticValues(info, expression, scope)) {
      if (value.kind === "known" && isTenantResourceHelperName(value.value)) {
        return value.value;
      }
    }
    return null;
  }

  function isVerifiedActorTokenIdentifier(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    resolving: Set<string>,
  ): boolean {
    const provenance = tokenIdentifierProvenance(info, expression, scope, state, resolving);
    if (!provenance.fromActionCtx) return false;
    for (const binding of provenance.tokenBindings) {
      if (state.checkedTokenBindings.has(binding)) return true;
    }
    if (provenance.optional) return false;
    for (const binding of provenance.identityBindings) {
      if (state.checkedIdentityTokenBindings.has(binding)) {
        return true;
      }
    }
    return false;
  }

  function addPresenceCheck(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
  ): void {
    const tokenProvenance = tokenIdentifierProvenance(info, expression, scope, state, new Set());
    if (tokenProvenance.fromActionCtx) {
      for (const binding of tokenProvenance.tokenBindings) {
        state.checkedTokenBindings.add(binding);
      }
      if (isTokenIdentifierAccess(unwrapExpression(expression))) {
        for (const binding of tokenProvenance.identityBindings) {
          state.checkedIdentityTokenBindings.add(binding);
        }
      }
    }
  }

  function tokenIdentifierProvenance(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    resolving: Set<string>,
  ): {
    fromActionCtx: boolean;
    optional: boolean;
    identityBindings: Set<ScopedBinding>;
    tokenBindings: Set<ScopedBinding>;
  } {
    const target = unwrapExpression(expression);
    const optional = containsOptionalChain(target);

    if (isTokenIdentifierAccess(target)) {
      const base = tokenIdentifierAccessBase(target);
      const identity = identityProvenanceFor(info, base, scope, state, resolving);
      return {
        fromActionCtx: identity.fromActionCtx,
        optional: optional || identity.optional,
        identityBindings: identity.identityBindings,
        tokenBindings: new Set(),
      };
    }

    if (ts.isIdentifier(target)) {
      const binding = findAnyBinding(info, scope, target.text);
      if (!binding) {
        return emptyTokenProvenance(optional);
      }
      if (ts.isParameter(binding.node)) {
        return emptyTokenProvenance(optional);
      }
      const bindingKey = `${info.filePath}:token:${binding.id}`;
      if (resolving.has(bindingKey)) {
        return emptyTokenProvenance(optional);
      }
      const bindingProvenance = tokenIdentifierProvenanceFromBinding(
        info,
        binding,
        state,
        new Set(resolving).add(bindingKey),
      );
      bindingProvenance.optional ||= optional;
      if (bindingProvenance.fromActionCtx) {
        bindingProvenance.tokenBindings.add(binding);
      }
      return bindingProvenance;
    }

    return emptyTokenProvenance(optional);
  }

  function tokenIdentifierProvenanceFromBinding(
    info: CheckerSourceFile,
    binding: ScopedBinding,
    state: AuthorityState,
    resolving: Set<string>,
  ): {
    fromActionCtx: boolean;
    optional: boolean;
    identityBindings: Set<ScopedBinding>;
    tokenBindings: Set<ScopedBinding>;
  } {
    if (binding.value.kind !== "expression") return emptyTokenProvenance(false);
    if (
      binding.value.propertyPath.length === 1 &&
      binding.value.propertyPath[0] === "tokenIdentifier"
    ) {
      const expressionInfo = binding.value.expressionInfo ?? info;
      const identity = identityProvenanceFor(
        expressionInfo,
        binding.value.expression,
        binding.value.scope,
        state,
        resolving,
      );
      return {
        fromActionCtx: identity.fromActionCtx,
        optional: identity.optional,
        identityBindings: identity.identityBindings,
        tokenBindings: new Set(),
      };
    }
    if (binding.value.propertyPath.length > 0) return emptyTokenProvenance(false);
    const expressionInfo = binding.value.expressionInfo ?? info;
    return tokenIdentifierProvenance(
      expressionInfo,
      binding.value.expression,
      binding.value.scope,
      state,
      resolving,
    );
  }

  function identityProvenanceFor(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    resolving: Set<string>,
  ): {
    fromActionCtx: boolean;
    optional: boolean;
    identityBindings: Set<ScopedBinding>;
  } {
    const target = unwrapAwaitExpression(unwrapExpression(expression));
    const optional = containsOptionalChain(target);
    if (isGetUserIdentityCall(info, target, scope, state, resolving)) {
      return {
        fromActionCtx: true,
        optional,
        identityBindings: new Set(),
      };
    }

    if (!ts.isIdentifier(target)) {
      return { fromActionCtx: false, optional, identityBindings: new Set() };
    }

    const binding = findAnyBinding(info, scope, target.text);
    if (!binding || binding.value.kind !== "expression") {
      return { fromActionCtx: false, optional, identityBindings: new Set() };
    }
    if (ts.isParameter(binding.node) && !state.ctxBindings.has(binding)) {
      return { fromActionCtx: false, optional, identityBindings: new Set() };
    }
    const bindingKey = `${info.filePath}:identity:${binding.id}`;
    if (resolving.has(bindingKey)) {
      return { fromActionCtx: false, optional, identityBindings: new Set() };
    }
    if (binding.value.propertyPath.length > 0) {
      return { fromActionCtx: false, optional, identityBindings: new Set() };
    }

    const expressionInfo = binding.value.expressionInfo ?? info;
    const provenance = identityProvenanceFor(
      expressionInfo,
      binding.value.expression,
      binding.value.scope,
      state,
      new Set(resolving).add(bindingKey),
    );
    provenance.optional ||= optional;
    if (provenance.fromActionCtx) {
      provenance.identityBindings.add(binding);
    }
    return provenance;
  }

  function isGetUserIdentityCall(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    resolving: Set<string>,
  ): boolean {
    const call = unwrapExpression(expression);
    if (!ts.isCallExpression(call)) return false;
    const target = unwrapExpression(call.expression);
    return (
      ts.isPropertyAccessExpression(target) &&
      target.name.text === "getUserIdentity" &&
      ts.isPropertyAccessExpression(target.expression) &&
      target.expression.name.text === "auth" &&
      isActionCtxExpression(info, target.expression.expression, scope, state, resolving)
    );
  }

  function isActionCtxExpression(
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    state: AuthorityState,
    resolving: Set<string>,
  ): boolean {
    const target = unwrapExpression(expression);
    if (!ts.isIdentifier(target)) return false;
    const binding = findAnyBinding(info, scope, target.text);
    if (!binding) return false;
    if (state.ctxBindings.has(binding)) return true;
    const bindingKey = `${info.filePath}:ctx:${binding.id}`;
    if (resolving.has(bindingKey) || binding.value.kind !== "expression") return false;
    if (binding.value.propertyPath.length > 0) return false;
    const expressionInfo = binding.value.expressionInfo ?? info;
    return isActionCtxExpression(
      expressionInfo,
      binding.value.expression,
      binding.value.scope,
      state,
      new Set(resolving).add(bindingKey),
    );
  }

  function visitRoots(): void {
    for (const filePath of rootFilePaths) {
      const info = sourceFiles.get(filePath);
      if (!info) continue;
      for (const root of collectAuthorityRoots(info)) {
        if (root.kind === "resourceCreatorBootstrap") {
          visitResourceCreatorBootstrap(root);
          continue;
        }
        const mode = authorityModeForBuilder(root.builder);
        if (mode) {
          visitConvexFunction(
            root,
            createAuthorityState(mode, isBrowserCallableBuilder(root.builder)),
          );
        }
      }
    }
  }

  visitRoots();

  return findings;
}

function convexBuilderForKnownValue(
  value: Extract<StaticValue, { kind: "known" }>["value"],
): ConvexFunctionBuilder | null {
  switch (value) {
    case "publicQuery":
    case "publicMutation":
    case "publicAction":
    case "authenticatedQuery":
    case "authenticatedMutation":
    case "authenticatedAction":
    case "iamQuery":
    case "iamMutation":
    case "iamAction":
    case "rawAction":
    case "internalAction":
      return value;
    default:
      return null;
  }
}

function authorityModeForBuilder(builder: ConvexFunctionBuilder): SdkIamAuthorityMode | null {
  switch (builder) {
    case "authenticatedAction":
    case "iamAction":
      return "user";
    case "internalAction":
      return "service";
    case "publicAction":
    case "rawAction":
    case "publicQuery":
    case "publicMutation":
    case "authenticatedQuery":
    case "authenticatedMutation":
    case "iamQuery":
    case "iamMutation":
      return "reject";
  }
}

function isBrowserCallableBuilder(builder: ConvexFunctionBuilder): boolean {
  switch (builder) {
    case "publicQuery":
    case "publicMutation":
    case "publicAction":
    case "authenticatedQuery":
    case "authenticatedMutation":
    case "authenticatedAction":
    case "iamQuery":
    case "iamMutation":
    case "iamAction":
      return true;
    case "rawAction":
    case "internalAction":
      return false;
  }
}

function createAuthorityState(mode: SdkIamAuthorityMode, trackPublicArgs = false): AuthorityState {
  return {
    mode,
    ctxBindings: new Set(),
    publicArgsBindings: new Set(),
    trackPublicArgs,
    checkedTokenBindings: new Set(),
    checkedIdentityTokenBindings: new Set(),
  };
}

function cloneAuthorityState(state: AuthorityState): AuthorityState {
  return {
    mode: state.mode,
    ctxBindings: new Set(state.ctxBindings),
    publicArgsBindings: new Set(state.publicArgsBindings),
    trackPublicArgs: state.trackPublicArgs,
    checkedTokenBindings: new Set(state.checkedTokenBindings),
    checkedIdentityTokenBindings: new Set(state.checkedIdentityTokenBindings),
  };
}

function snapshotAuthorityState(state: AuthorityState): AuthorityState {
  return cloneAuthorityState(state);
}

function restoreAuthorityState(state: AuthorityState, snapshot: AuthorityState): void {
  state.ctxBindings = new Set(snapshot.ctxBindings);
  state.publicArgsBindings = new Set(snapshot.publicArgsBindings);
  state.trackPublicArgs = snapshot.trackPublicArgs;
  state.checkedTokenBindings = new Set(snapshot.checkedTokenBindings);
  state.checkedIdentityTokenBindings = new Set(snapshot.checkedIdentityTokenBindings);
}

function conservativelyMergeAuthorityStates(
  before: AuthorityState,
  alternatives: AuthorityState[],
): AuthorityState {
  const merged = cloneAuthorityState(before);
  for (const alternative of alternatives) {
    for (const binding of merged.ctxBindings) {
      if (!alternative.ctxBindings.has(binding)) merged.ctxBindings.delete(binding);
    }
    for (const binding of merged.publicArgsBindings) {
      if (!alternative.publicArgsBindings.has(binding)) {
        merged.publicArgsBindings.delete(binding);
      }
    }
    for (const binding of merged.checkedTokenBindings) {
      if (!alternative.checkedTokenBindings.has(binding)) {
        merged.checkedTokenBindings.delete(binding);
      }
    }
    for (const binding of merged.checkedIdentityTokenBindings) {
      if (!alternative.checkedIdentityTokenBindings.has(binding)) {
        merged.checkedIdentityTokenBindings.delete(binding);
      }
    }
  }
  return merged;
}

function truthyPresenceExpressions(expression: ts.Expression): ts.Expression[] {
  const target = unwrapExpression(expression);
  if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.ExclamationToken) {
    return [];
  }
  if (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [...truthyPresenceExpressions(target.left), ...truthyPresenceExpressions(target.right)];
  }
  if (ts.isBinaryExpression(target)) {
    if (isPositiveNullishCheck(target)) {
      return [nonNullishSide(target)!];
    }
    if (isNegativeNullishCheck(target)) {
      return [];
    }
  }
  return [target];
}

function falsyPresenceExpressions(expression: ts.Expression): ts.Expression[] {
  const target = unwrapExpression(expression);
  if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.ExclamationToken) {
    return truthyPresenceExpressions(target.operand);
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...falsyPresenceExpressions(target.left), ...falsyPresenceExpressions(target.right)];
  }
  if (ts.isBinaryExpression(target) && isNegativeNullishCheck(target)) {
    return [nonNullishSide(target)!];
  }
  return [];
}

function isPositiveNullishCheck(expression: ts.BinaryExpression): boolean {
  return (
    (expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
    nonNullishSide(expression) !== null
  );
}

function isNegativeNullishCheck(expression: ts.BinaryExpression): boolean {
  return (
    (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) &&
    nonNullishSide(expression) !== null
  );
}

function nonNullishSide(expression: ts.BinaryExpression): ts.Expression | null {
  if (isNullishLiteral(unwrapExpression(expression.left))) return expression.right;
  if (isNullishLiteral(unwrapExpression(expression.right))) return expression.left;
  return null;
}

function isNullishLiteral(expression: ts.Expression): boolean {
  return (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined")
  );
}

function statementCanFallThrough(statement: ts.Statement): boolean {
  if (ts.isThrowStatement(statement) || ts.isReturnStatement(statement)) {
    return false;
  }
  if (ts.isBlock(statement)) {
    const lastStatement = statement.statements.at(-1);
    return lastStatement ? statementCanFallThrough(lastStatement) : true;
  }
  if (ts.isIfStatement(statement) && statement.elseStatement) {
    return (
      statementCanFallThrough(statement.thenStatement) ||
      statementCanFallThrough(statement.elseStatement)
    );
  }
  return true;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.EqualsToken:
    case ts.SyntaxKind.PlusEqualsToken:
    case ts.SyntaxKind.MinusEqualsToken:
    case ts.SyntaxKind.AsteriskEqualsToken:
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken:
    case ts.SyntaxKind.SlashEqualsToken:
    case ts.SyntaxKind.PercentEqualsToken:
    case ts.SyntaxKind.LessThanLessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken:
    case ts.SyntaxKind.AmpersandEqualsToken:
    case ts.SyntaxKind.BarEqualsToken:
    case ts.SyntaxKind.CaretEqualsToken:
    case ts.SyntaxKind.BarBarEqualsToken:
    case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
    case ts.SyntaxKind.QuestionQuestionEqualsToken:
      return true;
    default:
      return false;
  }
}

function unwrapAwaitExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAwaitExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return current;
}

function containsOptionalChain(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      "questionDotToken" in child &&
      (child as { questionDotToken?: unknown }).questionDotToken !== undefined
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isTokenIdentifierAccess(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === "tokenIdentifier";
}

function tokenIdentifierAccessBase(node: ts.Expression): ts.Expression {
  return (node as ts.PropertyAccessExpression).expression;
}

function emptyTokenProvenance(optional: boolean): {
  fromActionCtx: boolean;
  optional: boolean;
  identityBindings: Set<ScopedBinding>;
  tokenBindings: Set<ScopedBinding>;
} {
  return {
    fromActionCtx: false,
    optional,
    identityBindings: new Set(),
    tokenBindings: new Set(),
  };
}

function findAnyBinding(
  info: CheckerSourceFile,
  scope: LexicalScope | null,
  name: string,
): ScopedBinding | null {
  return findLexicalBinding(scope, name) ?? info.bindings.get(name) ?? null;
}

function collectTopLevelBindings(sourceFile: ts.SourceFile): Map<string, ScopedBinding> {
  const bindings = new Map<string, ScopedBinding>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) {
        bindings.set(statement.name.text, {
          id: `${statement.pos}:${statement.name.text}`,
          node: statement,
          value: { kind: "callable", node: statement, scope: null },
        });
      }
      if (hasDefaultModifier(statement)) {
        bindings.set("default", {
          id: `${statement.pos}:default`,
          node: statement,
          value: { kind: "callable", node: statement, scope: null },
        });
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      bindings.set("default", {
        id: `${statement.pos}:default`,
        node: statement,
        value: {
          kind: "expression",
          expression: statement.expression,
          scope: null,
          propertyPath: [],
        },
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      addBindingNamesToMap(bindings, declaration.name, declaration, null, declaration.initializer);
    }
  }
  return bindings;
}

function collectExportBindings(sourceFile: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement)) {
      if (statement.name) {
        bindings.set(statement.name.text, statement.name.text);
      }
      if (hasDefaultModifier(statement)) {
        bindings.set("default", statement.name?.text ?? "default");
      }
      continue;
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of collectBindingNames(declaration.name)) {
          bindings.set(name, name);
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      const expression = unwrapExpression(statement.expression);
      bindings.set("default", ts.isIdentifier(expression) ? expression.text : "default");
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) continue;
    const exportClause = statement.exportClause;
    if (!exportClause || !ts.isNamedExports(exportClause)) continue;
    for (const specifier of exportClause.elements) {
      bindings.set(specifier.name.text, (specifier.propertyName ?? specifier.name).text);
    }
  }
  return bindings;
}

function collectModuleImports(
  sourceFile: ts.SourceFile,
  sourceFiles: Map<string, CheckerSourceFile>,
): {
  bindings: Map<string, ImportedBinding>;
  namespaces: Map<string, ModuleTarget>;
} {
  const bindings = new Map<string, ImportedBinding>();
  const namespaces = new Map<string, ModuleTarget>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const target = resolveModuleTarget(
      sourceFile.fileName,
      statement.moduleSpecifier.text,
      sourceFiles,
    );
    if (!target) continue;
    const importClause = statement.importClause;
    if (!importClause) continue;
    if (importClause.name) {
      bindings.set(importClause.name.text, {
        target,
        exportedName: "default",
      });
    }
    const namedBindings = importClause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      namespaces.set(namedBindings.name.text, target);
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const specifier of namedBindings.elements) {
        if (specifier.isTypeOnly) continue;
        bindings.set(specifier.name.text, {
          target,
          exportedName: (specifier.propertyName ?? specifier.name).text,
        });
      }
    }
  }
  return { bindings, namespaces };
}

function collectModuleReExports(
  sourceFile: ts.SourceFile,
  sourceFiles: Map<string, CheckerSourceFile>,
): {
  bindings: Map<string, ImportedBinding>;
  namespaces: Map<string, ModuleTarget>;
  exportAllTargets: ModuleTarget[];
} {
  const bindings = new Map<string, ImportedBinding>();
  const namespaces = new Map<string, ModuleTarget>();
  const exportAllTargets: ModuleTarget[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const target = resolveModuleTarget(
      sourceFile.fileName,
      statement.moduleSpecifier.text,
      sourceFiles,
    );
    if (!target) continue;
    const exportClause = statement.exportClause;
    if (!exportClause) {
      exportAllTargets.push(target);
      continue;
    }
    if (ts.isNamespaceExport(exportClause)) {
      namespaces.set(exportClause.name.text, target);
    } else if (ts.isNamedExports(exportClause)) {
      for (const specifier of exportClause.elements) {
        if (specifier.isTypeOnly) continue;
        bindings.set(specifier.name.text, {
          target,
          exportedName: (specifier.propertyName ?? specifier.name).text,
        });
      }
    }
  }
  return { bindings, namespaces, exportAllTargets };
}

function resolveModuleTarget(
  fromFilePath: string,
  moduleSpecifier: string,
  sourceFiles: Map<string, CheckerSourceFile>,
): ModuleTarget | null {
  if (isGeneratedServerImport(moduleSpecifier)) {
    return { kind: "external", moduleSpecifier: generatedServerModuleSpecifier };
  }
  if (moduleSpecifier.startsWith(".")) {
    const targetFilePath = resolveLocalSourceFile(fromFilePath, moduleSpecifier, sourceFiles);
    return targetFilePath ? { kind: "local", filePath: targetFilePath } : null;
  }
  return { kind: "external", moduleSpecifier };
}

function resolveLocalSourceFile(
  fromFilePath: string,
  moduleSpecifier: string,
  sourceFiles: Map<string, CheckerSourceFile>,
): string | null {
  return (
    localSourceFileCandidates(fromFilePath, moduleSpecifier).find((candidate) =>
      sourceFiles.has(candidate),
    ) ?? null
  );
}

function localSourceFileCandidates(fromFilePath: string, moduleSpecifier: string): string[] {
  if (!moduleSpecifier.startsWith(".")) return [];
  const basePath = resolve(dirname(fromFilePath), moduleSpecifier);
  const baseExtension = extname(basePath);
  const extensionlessBasePath = sourceExtensions.has(baseExtension)
    ? basePath.slice(0, -baseExtension.length)
    : basePath;
  return [
    basePath,
    ...[...sourceExtensions].map((extension) => `${extensionlessBasePath}${extension}`),
    ...[...sourceExtensions].map((extension) => join(extensionlessBasePath, `index${extension}`)),
  ];
}

function isCallableNode(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

function collectDirectBlockBindings(block: ts.Block, scope: LexicalScope): void {
  collectDirectStatementBindings(block.statements, scope);
}

function collectDirectCaseBlockBindings(caseBlock: ts.CaseBlock, scope: LexicalScope): void {
  for (const clause of caseBlock.clauses) {
    collectDirectStatementBindings(clause.statements, scope);
  }
}

function collectDirectStatementBindings(
  statements: ts.NodeArray<ts.Statement>,
  scope: LexicalScope,
): void {
  for (const statement of statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      addBindingNames(scope, statement.name, statement, scope);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      addBindingNames(scope, declaration.name, declaration, scope);
    }
  }
}

function createChildScope(parent: LexicalScope | null): LexicalScope {
  return { parent, bindings: new Map() };
}

function addBindingNames(
  scope: LexicalScope,
  name: ts.BindingName,
  node: ts.Node,
  declarationScope: LexicalScope,
): void {
  addBindingNamesToMap(
    scope.bindings,
    name,
    node,
    declarationScope,
    ts.isVariableDeclaration(node) ? node.initializer : undefined,
  );
}

function addBindingNamesToMap(
  bindings: Map<string, ScopedBinding>,
  name: ts.BindingName,
  node: ts.Node,
  declarationScope: LexicalScope | null,
  initializer: ts.Expression | undefined,
  propertyPath: string[] = [],
): void {
  if (ts.isIdentifier(name)) {
    const value: BindingValue = isCallableNode(node)
      ? { kind: "callable", node, scope: declarationScope }
      : initializer
        ? {
            kind: "expression",
            expression: initializer,
            scope: declarationScope,
            propertyPath,
          }
        : { kind: "unknown" };
    bindings.set(name.text, {
      id: `${node.pos}:${name.text}:${propertyPath.join(".")}`,
      node,
      value,
    });
    return;
  }

  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (element.dotDotDotToken) {
        addBindingNamesToMap(bindings, element.name, element, declarationScope, undefined);
        continue;
      }
      const propertyName = bindingElementPropertyName(element);
      addBindingNamesToMap(
        bindings,
        element.name,
        node,
        declarationScope,
        initializer,
        propertyName === null ? [] : [...propertyPath, propertyName],
      );
    }
    return;
  }

  name.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) return;
    if (element.dotDotDotToken) {
      addBindingNamesToMap(bindings, element.name, element, declarationScope, undefined);
      return;
    }
    addBindingNamesToMap(bindings, element.name, node, declarationScope, initializer, [
      ...propertyPath,
      String(index),
    ]);
  });
}

function bindingElementPropertyName(element: ts.BindingElement): string | null {
  const propertyName = element.propertyName;
  if (
    propertyName &&
    (ts.isIdentifier(propertyName) ||
      ts.isStringLiteralLike(propertyName) ||
      ts.isNumericLiteral(propertyName))
  ) {
    return propertyName.text;
  }
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : collectBindingNames(element.name),
  );
}

function assignBindingExpression(
  left: ts.Expression,
  right: ts.Expression,
  scope: LexicalScope | null,
): void {
  const target = unwrapExpression(left);
  if (!ts.isIdentifier(target)) return;
  const binding = findLexicalBinding(scope, target.text);
  if (!binding) return;
  binding.value = {
    kind: "expression",
    expression: right,
    scope,
    propertyPath: [],
  };
}

type BindingSnapshot = Map<ScopedBinding, BindingValue>;

function snapshotBindingValues(scope: LexicalScope | null): BindingSnapshot {
  const snapshot: BindingSnapshot = new Map();
  let current = scope;
  while (current) {
    for (const binding of current.bindings.values()) {
      if (!snapshot.has(binding)) {
        snapshot.set(binding, binding.value);
      }
    }
    current = current.parent;
  }
  return snapshot;
}

function restoreBindingValues(snapshot: BindingSnapshot): void {
  for (const [binding, value] of snapshot) {
    binding.value = value;
  }
}

function mergeBindingValues(before: BindingSnapshot, alternatives: BindingSnapshot[]): void {
  for (const [binding, initialValue] of before) {
    const values = alternatives.map((alternative) => alternative.get(binding) ?? initialValue);
    binding.value = values.every((value) => bindingValuesEqual(value, values[0]!))
      ? values[0]!
      : { kind: "unknown" };
  }
}

function bindingValuesEqual(left: BindingValue, right: BindingValue): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unknown" || right.kind === "unknown") return true;
  if (left.kind === "callable" && right.kind === "callable") {
    return left.node === right.node && left.scope === right.scope;
  }
  if (left.kind === "expression" && right.kind === "expression") {
    return (
      left.expression === right.expression &&
      left.expressionInfo === right.expressionInfo &&
      left.scope === right.scope &&
      left.propertyPath.length === right.propertyPath.length &&
      left.propertyPath.every((propertyName, index) => propertyName === right.propertyPath[index])
    );
  }
  return false;
}

function collectForInitializerBindings(initializer: ts.ForInitializer, scope: LexicalScope): void {
  if (!ts.isVariableDeclarationList(initializer)) return;
  for (const declaration of initializer.declarations) {
    addBindingNames(scope, declaration.name, declaration, scope);
  }
}

function findLexicalBinding(scope: LexicalScope | null, name: string): ScopedBinding | null {
  let current = scope;
  while (current) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
    current = current.parent;
  }
  return null;
}

function collectInternalApiNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isGeneratedApiImport(statement.moduleSpecifier.text)
    ) {
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

function getInternalApiReferencePath(
  node: ts.Node,
  info: CheckerSourceFile,
  scope: LexicalScope | null,
  resolving: Set<string>,
): string[] | null {
  if (ts.isIdentifier(node)) {
    const lexicalBinding = findLexicalBinding(scope, node.text);
    if (lexicalBinding) {
      return getInternalApiPathFromBinding(lexicalBinding, info, resolving);
    }

    const key = `${info.filePath}:internal:${node.text}`;
    if (resolving.has(key)) return null;
    const binding = info.bindings.get(node.text);
    if (binding) {
      return getInternalApiPathFromBinding(binding, info, new Set(resolving).add(key));
    }

    return info.internalApiNames.has(node.text) ? [] : null;
  }

  if (ts.isPropertyAccessExpression(node)) {
    const parent = getInternalApiReferencePath(
      unwrapExpression(node.expression),
      info,
      scope,
      resolving,
    );
    return parent === null ? null : [...parent, node.name.text];
  }

  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression && unwrapExpression(node.argumentExpression);
    if (!argument || !ts.isStringLiteralLike(argument)) return null;
    const parent = getInternalApiReferencePath(
      unwrapExpression(node.expression),
      info,
      scope,
      resolving,
    );
    return parent === null ? null : [...parent, argument.text];
  }

  return null;
}

function getInternalApiPathFromBinding(
  binding: ScopedBinding,
  info: CheckerSourceFile,
  resolving: Set<string>,
): string[] | null {
  const bindingKey = `${info.filePath}:internal-binding:${binding.id}`;
  if (resolving.has(bindingKey)) return null;
  const nextResolving = new Set(resolving).add(bindingKey);

  if (binding.value.kind !== "expression") return null;
  const path = getInternalApiReferencePath(
    unwrapExpression(binding.value.expression),
    info,
    binding.value.scope,
    nextResolving,
  );
  return path === null ? null : [...path, ...binding.value.propertyPath];
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

function checkRuntimeSupersetPermissionKeys(cwd: string, filePath: string): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: IamCheckFinding[] = [];

  for (const definition of collectManagedBuilderDefinitions(sourceFile, [
    "iamQuery",
    "iamMutation",
    "iamAction",
  ])) {
    const permission = getLiteralPermissionProperty(definition.definition);
    if (!permission) continue;
    const actionSeparatorIndex = permission.key.lastIndexOf(":");
    const action =
      actionSeparatorIndex === -1 ? "" : permission.key.slice(actionSeparatorIndex + 1);
    if (action !== "manage" && action !== "*") continue;

    findings.push(
      createPatternFindingAtNode({
        cwd,
        sourceFile,
        node: permission.node,
        code: "runtime_superset_permission",
        message: `Permission key "${permission.key}" is a catalog grouping key, not a runtime action.`,
        suggestion:
          "Check a concrete permission action at runtime, such as read, create, update, delete, list, or an app-defined action.",
      }),
    );
  }

  return findings;
}

type IamCatalogPermission = {
  key: string;
  resourceType: string;
  action: string;
};

type IamCatalogRole = {
  key: string;
  type: "built_in" | "custom" | "unknown";
  id?: string;
};

type IamCatalog = {
  canonicalPermissionKeys: Set<string> | null;
  permissionsByKey: Map<string, IamCatalogPermission>;
  rolesByKey: Map<string, IamCatalogRole>;
  rolesById: Map<string, IamCatalogRole>;
  rolePermissionsByRoleKey: Map<string, string[]>;
};

// The IAM catalog is file-only: hercules/iam.jsonc at the app root declares
// every app permission key, reusable role, and reusable role-permission mapping.
// Returns null when the file is missing or cannot be parsed as JSONC. Individual
// malformed sections are treated as unresolved so the checker does not invent
// false positives for a file the real compiler will reject separately.
function loadIamCatalog(cwd: string): IamCatalog | null {
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
  const config = parsed.config as Record<string, unknown> | undefined;
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return null;
  }

  const permissionsByKey = parseCatalogPermissions(config.permissions);
  const rolesByKey = parseCatalogRoles(config.roles);
  const rolesById = new Map<string, IamCatalogRole>();
  for (const role of rolesByKey.values()) {
    if (role.id) rolesById.set(role.id, role);
  }

  return {
    canonicalPermissionKeys:
      isPlainObject(config.permissions) && permissionsByKey !== null
        ? new Set(Object.keys(config.permissions))
        : null,
    permissionsByKey: permissionsByKey ?? new Map(),
    rolesByKey,
    rolesById,
    rolePermissionsByRoleKey: parseCatalogRolePermissions(config.rolePermissions),
  };
}

function parseCatalogPermissions(value: unknown): Map<string, IamCatalogPermission> | null {
  if (!isPlainObject(value)) return null;
  const permissions = new Map<string, IamCatalogPermission>();
  for (const key of Object.keys(value)) {
    const parsed = parseCatalogPermissionKey(key);
    if (parsed) permissions.set(key, parsed);
  }
  return permissions;
}

function parseCatalogRoles(value: unknown): Map<string, IamCatalogRole> {
  const roles = new Map<string, IamCatalogRole>();
  if (!isPlainObject(value)) return roles;

  for (const [key, rawRole] of Object.entries(value)) {
    const role = isPlainObject(rawRole) ? rawRole : {};
    const type = role.type === "built_in" || role.type === "custom" ? role.type : "unknown";
    const id =
      typeof role.id === "string"
        ? role.id
        : typeof role.roleId === "string"
          ? role.roleId
          : undefined;
    roles.set(key, { key, type, ...(id ? { id } : {}) });
  }
  return roles;
}

function parseCatalogRolePermissions(value: unknown): Map<string, string[]> {
  const rolePermissions = new Map<string, string[]>();
  if (!isPlainObject(value)) return rolePermissions;

  for (const [roleKey, rawPermissions] of Object.entries(value)) {
    if (!Array.isArray(rawPermissions)) continue;
    const permissionKeys = rawPermissions.filter(
      (permission): permission is string => typeof permission === "string",
    );
    rolePermissions.set(roleKey, permissionKeys);
  }
  return rolePermissions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCatalogPermissionKey(key: string): IamCatalogPermission | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return {
    key,
    resourceType: key.slice(0, separator),
    action: key.slice(separator + 1),
  };
}

function resolveCatalogRole(
  catalog: IamCatalog,
  reference: { kind: "key" | "id"; value: string },
): { kind: "resolved"; role: IamCatalogRole } | { kind: "missing" } | { kind: "unresolved" } {
  if (reference.kind === "key") {
    return catalog.rolesByKey.has(reference.value)
      ? { kind: "resolved", role: catalog.rolesByKey.get(reference.value)! }
      : { kind: "missing" };
  }

  if (catalog.rolesById.size === 0) return { kind: "unresolved" };
  return catalog.rolesById.has(reference.value)
    ? { kind: "resolved", role: catalog.rolesById.get(reference.value)! }
    : { kind: "missing" };
}

function validateBootstrapRoleForResource(
  catalog: IamCatalog,
  role: IamCatalogRole,
  resourceType: string,
  appliesTo: string | null,
): string | null {
  if (role.type === "built_in") {
    return "built-in roles are platform roles and cannot be granted on an exact resource";
  }

  const permissionKeys = catalog.rolePermissionsByRoleKey.get(role.key) ?? [];
  if (permissionKeys.length === 0) {
    return "the role has no catalog permissions to grant";
  }

  for (const permissionKey of permissionKeys) {
    const parsed =
      catalog.permissionsByKey.get(permissionKey) ?? parseCatalogPermissionKey(permissionKey);
    if (!parsed) {
      return `permission "${permissionKey}" is not a valid catalog permission key`;
    }
    if (parsed.action === "*") {
      return `permission "${permissionKey}" is a wildcard permission, which cannot be granted on a resource`;
    }
  }

  const managerLever = `${resourceType}:manage_members`;
  const privilegedKeys = permissionKeys.filter(isPrivilegedCatalogPermissionKey);
  if (privilegedKeys.length > 0) {
    const invalidPrivilegedKey = privilegedKeys.find(
      (permissionKey) => permissionKey !== managerLever,
    );
    if (invalidPrivilegedKey) {
      return `permission "${invalidPrivilegedKey}" is privileged and is not the target resource's own manage_members permission`;
    }
    return null;
  }

  const hasTargetTypePermission = permissionKeys.some((permissionKey) => {
    const parsed =
      catalog.permissionsByKey.get(permissionKey) ?? parseCatalogPermissionKey(permissionKey);
    return parsed?.resourceType === resourceType;
  });
  if (!hasTargetTypePermission && appliesTo !== "self_and_descendants") {
    return "the role grants no permission for the bootstrap resource type";
  }

  return null;
}

function isPrivilegedCatalogPermissionKey(permissionKey: string): boolean {
  if (permissionKey.startsWith("system.")) return true;
  const parsed = parseCatalogPermissionKey(permissionKey);
  if (!parsed) return false;
  return parsed.action === "manage_members" || parsed.action === "manage_access";
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
): IamCheckFinding[] {
  if (!catalogPermissionKeys) {
    return [];
  }

  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: IamCheckFinding[] = [];

  for (const definition of collectManagedBuilderDefinitions(sourceFile, [
    "iamQuery",
    "iamMutation",
    "iamAction",
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
  code: IamCheckFinding["code"];
  message: string;
  suggestion: string;
}): IamCheckFinding {
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
  findings: IamCheckFinding[];
  cwd: string;
  filePath: string;
  sourceText: string;
  code: IamCheckFinding["code"];
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
  const builderNamesToReplace = new Set(
    candidates.flatMap((candidate) =>
      ts.isIdentifier(candidate.builderNode) ? [candidate.builderNode.text] : [],
    ),
  );
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

function buildIamImportReplacement(
  sourceFile: ts.SourceFile,
  sourceText: string,
  iamImports: Set<string>,
  convexDir: string,
): { start: number; end: number; text: string } {
  const sortedImports = [...iamImports].sort();
  const iamImport = findIamImport(sourceFile, convexDir);

  if (iamImport?.namedBindings && ts.isNamedImports(iamImport.namedBindings)) {
    const existingNames = new Set(
      iamImport.namedBindings.elements.map((specifier) => specifier.name.text),
    );
    const missingNames = sortedImports.filter((name) => !existingNames.has(name));
    if (missingNames.length === 0) {
      return { start: 0, end: 0, text: "" };
    }

    const closingBraceStart = iamImport.namedBindings.getEnd() - 1;
    const prefix = iamImport.namedBindings.elements.length > 0 ? ", " : "";
    return {
      start: closingBraceStart,
      end: closingBraceStart,
      text: `${prefix}${missingNames.join(", ")}`,
    };
  }

  const iamImportPath = buildIamImportPath(sourceFile, convexDir);
  const importLine = `import { ${sortedImports.join(", ")} } from "${iamImportPath}";\n`;
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

function findIamImport(
  sourceFile: ts.SourceFile,
  convexDir: string,
): { namedBindings?: ts.NamedImportBindings } | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) {
      continue;
    }
    if (
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !isIamImport(sourceFile, statement.moduleSpecifier.text, convexDir)
    ) {
      continue;
    }

    return { namedBindings: statement.importClause?.namedBindings };
  }

  return null;
}

function buildIamImportPath(sourceFile: ts.SourceFile, convexDir: string): string {
  const relativePath = normalizePath(
    relative(dirname(sourceFile.fileName), join(convexDir, "iam")),
  );
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function isIamImport(
  sourceFile: ts.SourceFile,
  moduleSpecifier: string,
  convexDir: string,
): boolean {
  if (!moduleSpecifier.startsWith(".")) {
    return false;
  }

  return (
    stripKnownModuleExtension(resolve(dirname(sourceFile.fileName), moduleSpecifier)) ===
    join(convexDir, "iam")
  );
}

function isIamWiringSourceFile(filePath: string | undefined, convexDir: string): boolean {
  if (!filePath) return false;
  const extensionlessPath = stripKnownModuleExtension(filePath);
  return extensionlessPath === join(convexDir, "iam");
}

// A Convex function file uses managed IAM when it imports @usehercules/sdk
// directly, the canonical convex/iam wiring module imports @usehercules/convex,
// or another Convex function imports that local wiring module.
function fileUsesManagedIam(filePath: string, convexDir: string): boolean {
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
      moduleSpecifier.text === herculesSdkPackageName ||
      ((moduleSpecifier.text === iamPackageName ||
        moduleSpecifier.text.startsWith(`${iamPackageName}/`)) &&
        isIamWiringSourceFile(filePath, convexDir)) ||
      isIamImport(sourceFile, moduleSpecifier.text, convexDir)
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

type RawBuilderResolution =
  | { kind: "builder"; builder: RawConvexBuilder }
  | { kind: "module"; target: ModuleTarget };

function collectStaticRawBuilderCandidates(
  sourceFile: ts.SourceFile,
  sourceFiles: Map<string, CheckerSourceFile>,
): RawBuilderCandidate[] {
  const info = sourceFiles.get(sourceFile.fileName);
  if (!info) return [];
  const candidates: RawBuilderCandidate[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isDirectExport = hasExportModifier(statement);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }

        const rawCall = getStaticRawBuilderCall(
          info,
          declaration.initializer,
          sourceFiles,
          new Set(),
        );
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
      const rawCall = getStaticRawBuilderCall(info, statement.expression, sourceFiles, new Set());
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

function getStaticRawBuilderCall(
  info: CheckerSourceFile,
  initializer: ts.Expression,
  sourceFiles: Map<string, CheckerSourceFile>,
  resolving: Set<string>,
): Pick<RawBuilderCandidate, "builder" | "builderNode"> | null {
  const expression = unwrapExpression(initializer);
  if (!ts.isCallExpression(expression)) return null;

  const callTarget = unwrapExpression(expression.expression);
  const builders = new Set(
    resolveRawBuilderValues(info, callTarget, sourceFiles, resolving).flatMap((value) =>
      value.kind === "builder" ? [value.builder] : [],
    ),
  );
  if (builders.size !== 1) return null;
  return { builder: [...builders][0]!, builderNode: callTarget };
}

function resolveRawBuilderValues(
  info: CheckerSourceFile,
  expression: ts.Expression,
  sourceFiles: Map<string, CheckerSourceFile>,
  resolving: Set<string>,
): RawBuilderResolution[] {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    const key = `${info.filePath}:raw-local:${target.text}`;
    if (resolving.has(key)) return [];
    const nextResolving = new Set(resolving).add(key);
    const binding = info.bindings.get(target.text);
    if (binding) {
      return resolveRawBuilderBinding(info, binding, sourceFiles, nextResolving);
    }
    const imported = info.imports.get(target.text);
    if (imported) {
      return resolveRawBuilderModuleExport(
        imported.target,
        imported.exportedName,
        sourceFiles,
        nextResolving,
      );
    }
    const namespaceImport = info.namespaceImports.get(target.text);
    return namespaceImport ? [{ kind: "module", target: namespaceImport }] : [];
  }

  if (ts.isPropertyAccessExpression(target)) {
    return resolveRawBuilderValues(info, target.expression, sourceFiles, resolving).flatMap(
      (value) => resolveRawBuilderProperty(value, target.name.text, sourceFiles, resolving),
    );
  }

  if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression && unwrapExpression(target.argumentExpression);
    if (!argument || !ts.isStringLiteralLike(argument)) return [];
    return resolveRawBuilderValues(info, target.expression, sourceFiles, resolving).flatMap(
      (value) => resolveRawBuilderProperty(value, argument.text, sourceFiles, resolving),
    );
  }

  if (ts.isConditionalExpression(target)) {
    return [
      ...resolveRawBuilderValues(info, target.whenTrue, sourceFiles, new Set(resolving)),
      ...resolveRawBuilderValues(info, target.whenFalse, sourceFiles, new Set(resolving)),
    ];
  }

  if (
    ts.isBinaryExpression(target) &&
    (target.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    return [
      ...resolveRawBuilderValues(info, target.left, sourceFiles, new Set(resolving)),
      ...resolveRawBuilderValues(info, target.right, sourceFiles, new Set(resolving)),
    ];
  }

  return [];
}

function resolveRawBuilderBinding(
  info: CheckerSourceFile,
  binding: ScopedBinding,
  sourceFiles: Map<string, CheckerSourceFile>,
  resolving: Set<string>,
): RawBuilderResolution[] {
  if (binding.value.kind !== "expression") return [];
  const expressionInfo = binding.value.expressionInfo ?? info;
  let values = resolveRawBuilderValues(
    expressionInfo,
    binding.value.expression,
    sourceFiles,
    resolving,
  );
  for (const propertyName of binding.value.propertyPath) {
    values = values.flatMap((value) =>
      resolveRawBuilderProperty(value, propertyName, sourceFiles, resolving),
    );
  }
  return values;
}

function resolveRawBuilderProperty(
  value: RawBuilderResolution,
  propertyName: string,
  sourceFiles: Map<string, CheckerSourceFile>,
  resolving: Set<string>,
): RawBuilderResolution[] {
  if (value.kind !== "module") return [];
  return resolveRawBuilderModuleExport(value.target, propertyName, sourceFiles, resolving);
}

function resolveRawBuilderModuleExport(
  target: ModuleTarget,
  exportedName: string,
  sourceFiles: Map<string, CheckerSourceFile>,
  resolving: Set<string>,
): RawBuilderResolution[] {
  if (target.kind === "external") {
    return target.moduleSpecifier === generatedServerModuleSpecifier &&
      isRawBuilderName(exportedName)
      ? [{ kind: "builder", builder: exportedName }]
      : [];
  }
  const info = sourceFiles.get(target.filePath);
  return info ? resolveRawBuilderExport(info, exportedName, sourceFiles, resolving) : [];
}

function resolveRawBuilderExport(
  info: CheckerSourceFile,
  exportedName: string,
  sourceFiles: Map<string, CheckerSourceFile>,
  resolving: Set<string>,
): RawBuilderResolution[] {
  const key = `${info.filePath}:raw-export:${exportedName}`;
  if (resolving.has(key)) return [];
  const nextResolving = new Set(resolving).add(key);

  const localName = info.exportBindings.get(exportedName);
  if (localName) {
    const binding = info.bindings.get(localName);
    if (binding) {
      return resolveRawBuilderBinding(info, binding, sourceFiles, nextResolving);
    }
    const imported = info.imports.get(localName);
    if (imported) {
      return resolveRawBuilderModuleExport(
        imported.target,
        imported.exportedName,
        sourceFiles,
        nextResolving,
      );
    }
    const namespaceImport = info.namespaceImports.get(localName);
    if (namespaceImport) {
      return [{ kind: "module", target: namespaceImport }];
    }
  }

  const reExport = info.reExports.get(exportedName);
  if (reExport) {
    return resolveRawBuilderModuleExport(
      reExport.target,
      reExport.exportedName,
      sourceFiles,
      nextResolving,
    );
  }
  const namespaceReExport = info.namespaceReExports.get(exportedName);
  if (namespaceReExport) {
    return [{ kind: "module", target: namespaceReExport }];
  }

  return info.exportAllTargets.flatMap((target) =>
    resolveRawBuilderModuleExport(target, exportedName, sourceFiles, nextResolving),
  );
}

function collectDirectRawBuilderCandidates(
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
): IamCheckFinding {
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
    suggestion: `Import from ./iam and choose public${builderSuffix}, authenticated${builderSuffix}, or iam${builderSuffix}.`,
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

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
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
  return (
    moduleSpecifier.endsWith("_generated/api") || moduleSpecifier.endsWith("_generated/api.js")
  );
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
