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

export type IamCheckFinding = {
  code:
    | "convex_dir_missing"
    | "raw_exported_convex_builder"
    | "placeholder_tenant_id"
    | "hardcoded_tenant_id"
    | "local_tenant_membership_table"
    | "optional_tenant_id"
    | "tenant_scoped_global_slug_lookup"
    | "tenant_row_from_arg"
    | "authenticated_tenant_data_read"
    | "existing_row_missing_resource_tenant"
    | "resource_capability_missing_resource"
    | "privileged_resource_permission_rule"
    | "public_service_authority_call"
    | "runtime_superset_permission"
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
const ignoredDirectories = new Set(["_generated", "node_modules", "dist", ".git"]);
const exemptFileNames = new Set(["iam.ts", "iam.tsx", "http.ts", "convex.config.ts"]);
const exemptionMarkers = ["hercules-iam: allow-raw-builder", "hercules-iam: allow-raw-builders"];
const iamPackageName = "@usehercules/convex";
const iamServicePackageNames = new Set([
  `${iamPackageName}/iam-service`,
  `${iamPackageName}/iam-service.js`,
]);
const serviceAuthorityHelperNames = new Set(["createIamInvitation", "createResourceInvitation"]);
const iamServiceActionNames = new Set([
  "addGroupMember",
  "archiveAdmissionRule",
  "archiveGroup",
  "archiveRole",
  "archiveTenant",
  "createAdmissionRule",
  "createGroup",
  "createInvitation",
  "createResourceGrant",
  "createRole",
  "createUser",
  "deleteGrant",
  "evaluateGrantableRoles",
  "listAdmissionRules",
  "listAuditEvents",
  "listGroupPermissionOverrides",
  "listInvitations",
  "listRolePermissionOverrides",
  "listUserPermissionOverrides",
  "removeGroupMember",
  "removeUser",
  "replaceGroupPermissionOverrides",
  "replaceGroupRoles",
  "replaceResourceGrants",
  "replaceResourcePermissionOverrides",
  "replaceRolePermissionOverrides",
  "replaceUserPermissionOverrides",
  "replaceUserRoles",
  "revokeInvitation",
  "updateAdmissionRule",
  "updateGrant",
  "updateGroup",
  "updateRole",
  "updateTenant",
  "updateUser",
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
  const authoritySourceFiles = [
    ...new Set([
      ...markerFiles,
      ...collectAppSourceFiles(cwd, convexDir, {
        includeExemptFiles: true,
      }),
    ]),
  ];
  const tenantOwnedTables = collectTenantOwnedTables(sourceFiles);
  const catalogPermissionKeys = loadCatalogPermissionKeys(cwd);
  const fixedFiles = options.fixAuthenticated
    ? sourceFiles.filter((filePath) => fixSourceFileToAuthenticatedBuilders(filePath, convexDir))
        .length
    : 0;
  const findings = [
    ...sourceFiles.flatMap((filePath) => checkSourceFile(cwd, filePath)),
    ...checkPublicServiceAuthorityCalls(cwd, convexDir, markerFiles, authoritySourceFiles),
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

function checkSourceFile(cwd: string, filePath: string): IamCheckFinding[] {
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
      "Use createIamTenant from @usehercules/convex/iam-management before inserting tenant metadata.",
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
      /\bctx\.db\.(?:get|patch|replace|delete)\s*\(\s*args\.[A-Za-z_$][\w$]*/.test(definition.text)
    ) {
      findings.push(
        createPatternFindingAtNode({
          cwd,
          sourceFile,
          node: definition.node,
          code: "tenant_row_from_arg",
          message:
            "Operations on a tenant-owned row id must authorize against the stored row tenant, not a caller supplied tenant id.",
          suggestion:
            'Use tenantFromResource("tableName", "rowIdArg") for row read, update, publish, moderation, and delete operations.',
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
      "Use the default tenant helper, or store tenant ids returned by createIamTenant on app rows and load them from the row.",
  });

  return findings;
}

function checkPrivilegedResourcePermissionRules(cwd: string, filePath: string): IamCheckFinding[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = createSourceFile(filePath, sourceText);
  const findings: IamCheckFinding[] = [];

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const permission = getStringProperty(node, "permissionKey");
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
  | { kind: "module"; target: ModuleTarget }
  | {
      kind: "known";
      value: "publicBuilder" | "serviceAuthority" | "iamServiceFactory" | "iamServiceActions";
    };

function checkPublicServiceAuthorityCalls(
  cwd: string,
  convexDir: string,
  rootFilePaths: string[],
  filePaths: string[],
): IamCheckFinding[] {
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

  const convexModules = new Map<string, CheckerSourceFile>();
  for (const info of sourceFiles.values()) {
    const relativePath = normalizePath(relative(convexDir, info.filePath));
    if (relativePath.startsWith("../")) continue;
    convexModules.set(stripKnownModuleExtension(relativePath), info);
  }
  const findings: IamCheckFinding[] = [];
  const findingKeys = new Set<string>();
  const visitedCallables = new Set<string>();

  const addFinding = (info: CheckerSourceFile, node: ts.Node) => {
    const key = `${info.filePath}:${node.getStart(info.sourceFile)}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(
      createPatternFindingAtNode({
        cwd,
        sourceFile: info.sourceFile,
        node,
        code: "public_service_authority_call",
        message: "Exported public Convex functions must not call service-authority IAM actions.",
        suggestion:
          "Use createIamManagementActions for public IAM changes, or keep the createIamServiceActions caller internal.",
      }),
    );
  };

  const visitCallableNode = (
    info: CheckerSourceFile,
    node: ts.Node,
    declarationScope: LexicalScope | null,
  ): void => {
    const callableKey = `${info.filePath}:${node.getStart(info.sourceFile)}`;
    if (visitedCallables.has(callableKey)) return;
    visitedCallables.add(callableKey);

    if (!isCallableNode(node)) return;
    const functionScope: LexicalScope = {
      parent: declarationScope,
      bindings: new Map(),
    };
    for (const parameter of node.parameters) {
      addBindingNames(functionScope, parameter.name, parameter, functionScope);
    }

    const body = node.body;
    if (!body) return;
    if (ts.isBlock(body)) {
      visitBlock(info, body, functionScope);
    } else {
      visitReachable(info, body, functionScope);
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

    let values = resolveStaticValues(
      info,
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
    if (!iamServicePackageNames.has(target.moduleSpecifier)) return [];
    if (serviceAuthorityHelperNames.has(exportedName)) {
      return [{ kind: "known", value: "serviceAuthority" }];
    }
    if (exportedName === "createIamServiceActions") {
      return [{ kind: "known", value: "iamServiceFactory" }];
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

    if (isIamWiringSourceFile(info.filePath, convexDir) && publicBuilderNames.has(exportedName)) {
      return [{ kind: "known", value: "publicBuilder" }];
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
      return value.value === "iamServiceActions" && iamServiceActionNames.has(propertyName)
        ? [{ kind: "known", value: "serviceAuthority" }]
        : [];
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

    if (ts.isCallExpression(target)) {
      const callTarget = unwrapExpression(target.expression);
      if (ts.isPropertyAccessExpression(callTarget) && callTarget.name.text === "bind") {
        return resolveStaticValues(info, callTarget.expression, scope, resolving);
      }

      const values: StaticValue[] = [];
      for (const callable of resolveStaticValues(info, target.expression, scope, resolving)) {
        if (callable.kind === "known" && callable.value === "iamServiceFactory") {
          values.push({ kind: "known", value: "iamServiceActions" });
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

  function isGeneratedServiceAuthorityReference(
    node: ts.Node,
    info: CheckerSourceFile,
    scope: LexicalScope | null,
  ): boolean {
    const path = getInternalApiReferencePath(node, info, scope, new Set());
    if (path === null || path.length === 0) return false;

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
      return path[0] === "iamService";
    }

    const exportedPath = path.slice(moduleSegmentCount);
    if (exportedPath.length === 0) return false;
    let values = resolveExportedValues(moduleInfo, exportedPath[0]!, new Set());
    for (const propertyName of exportedPath.slice(1)) {
      values = values.flatMap((value) => resolvePropertyValues(value, propertyName, new Set()));
    }
    return values.some((value) => value.kind === "known" && value.value === "serviceAuthority");
  }

  const visitCallableReference = (
    info: CheckerSourceFile,
    expression: ts.Expression,
    scope: LexicalScope | null,
    resolving: Set<string> = new Set(),
  ): void => {
    for (const value of resolveStaticValues(info, expression, scope, resolving)) {
      if (value.kind === "known" && value.value === "serviceAuthority") {
        addFinding(info, expression);
      } else if (value.kind === "node" && isCallableNode(value.node)) {
        visitCallableNode(value.info, value.node, value.declarationScope);
      }
    }
  };

  const visitBlock = (
    info: CheckerSourceFile,
    block: ts.Block,
    parentScope: LexicalScope,
  ): void => {
    const scope: LexicalScope = {
      parent: parentScope,
      bindings: new Map(),
    };
    collectDirectBlockBindings(block, scope);
    for (const statement of block.statements) {
      if (ts.isFunctionDeclaration(statement)) continue;
      visitReachable(info, statement, scope);
    }
  };

  const visitReachable = (
    info: CheckerSourceFile,
    node: ts.Node,
    scope: LexicalScope | null,
  ): void => {
    if (isGeneratedServiceAuthorityReference(node, info, scope)) {
      addFinding(info, node);
      return;
    }

    if (isCallableNode(node)) return;

    if (ts.isIfStatement(node)) {
      visitReachable(info, node.expression, scope);
      const before = snapshotBindingValues(scope);
      visitReachable(info, node.thenStatement, scope);
      const afterThen = snapshotBindingValues(scope);
      restoreBindingValues(before);
      if (node.elseStatement) {
        visitReachable(info, node.elseStatement, scope);
      }
      const afterElse = snapshotBindingValues(scope);
      mergeBindingValues(before, [afterThen, afterElse]);
      return;
    }

    if (ts.isBlock(node)) {
      visitBlock(info, node, scope ?? { parent: null, bindings: new Map() });
      return;
    }

    if (ts.isForStatement(node)) {
      const before = snapshotBindingValues(scope);
      const loopScope = createChildScope(scope);
      if (node.initializer) {
        collectForInitializerBindings(node.initializer, loopScope);
        visitReachable(info, node.initializer, loopScope);
      }
      if (node.condition) visitReachable(info, node.condition, loopScope);
      if (node.incrementor) {
        visitReachable(info, node.incrementor, loopScope);
      }
      visitReachable(info, node.statement, loopScope);
      restoreBindingValues(before);
      return;
    }

    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const before = snapshotBindingValues(scope);
      const loopScope = createChildScope(scope);
      collectForInitializerBindings(node.initializer, loopScope);
      visitReachable(info, node.initializer, loopScope);
      visitReachable(info, node.expression, loopScope);
      visitReachable(info, node.statement, loopScope);
      restoreBindingValues(before);
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
      visitReachable(info, node.block, catchScope);
      return;
    }

    if (ts.isCaseBlock(node)) {
      const before = snapshotBindingValues(scope);
      const switchScope = createChildScope(scope);
      collectDirectCaseBlockBindings(node, switchScope);
      for (const clause of node.clauses) {
        if (ts.isCaseClause(clause)) {
          visitReachable(info, clause.expression, switchScope);
        }
        for (const statement of clause.statements) {
          visitReachable(info, statement, switchScope);
        }
      }
      restoreBindingValues(before);
      return;
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      visitReachable(info, node.right, scope);
      assignBindingExpression(node.left, node.right, scope);
      return;
    }

    if (ts.isCallExpression(node)) {
      const target = unwrapExpression(node.expression);
      visitCallableReference(info, target, scope);
      visitReachable(info, target, scope);
      for (const argument of node.arguments) {
        // Do not infer whether an arbitrary higher-order callee invokes a
        // callback. A statically dangerous callable passed from a public
        // handler is itself service-authority exposure, so classify callable
        // arguments syntactically and still inspect the argument expression.
        visitCallableReference(info, argument, scope);
        visitReachable(info, argument, scope);
      }
      return;
    }

    ts.forEachChild(node, (child) => visitReachable(info, child, scope));
  };

  const collectPublicBuilderRoots = (info: CheckerSourceFile): ts.CallExpression[] => {
    const roots: ts.CallExpression[] = [];
    const exportedNames = collectExportedNames(info.sourceFile);
    const addRoot = (expression: ts.Expression): void => {
      const target = unwrapExpression(expression);
      if (!ts.isCallExpression(target)) return;
      const isPublicBuilder = resolveStaticValues(info, target.expression, null).some(
        (value) => value.kind === "known" && value.value === "publicBuilder",
      );
      if (isPublicBuilder) roots.push(target);
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

  const visitConfigObject = (
    info: CheckerSourceFile,
    config: ts.ObjectLiteralExpression,
    scope: LexicalScope | null,
    visitedProperties: Set<string> = new Set(),
  ): void => {
    for (let index = config.properties.length - 1; index >= 0; index -= 1) {
      const property = config.properties[index]!;
      if (ts.isSpreadAssignment(property)) {
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
            visitedProperties,
          );
        }
        continue;
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
        visitCallableNode(info, property, scope);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        if (property.name.text === "handler") {
          visitCallableReference(info, property.name, scope);
        } else {
          visitReachable(info, property, scope);
        }
        continue;
      }
      if (!ts.isPropertyAssignment(property)) {
        visitReachable(info, property, scope);
        continue;
      }
      const initializer = unwrapExpression(property.initializer);
      if (isCallableNode(initializer) || propertyName === "handler") {
        visitCallableReference(info, initializer, scope);
      } else {
        visitReachable(info, initializer, scope);
      }
    }
  };

  for (const filePath of rootFilePaths) {
    const info = sourceFiles.get(filePath);
    if (!info) continue;
    for (const root of collectPublicBuilderRoots(info)) {
      for (const argument of root.arguments) {
        let resolvedObject = false;
        for (const value of resolveStaticValues(info, argument, null)) {
          if (value.kind === "node" && ts.isObjectLiteralExpression(value.node)) {
            resolvedObject = true;
            visitConfigObject(value.info, value.node, value.declarationScope);
          }
        }
        if (!resolvedObject) {
          visitReachable(info, argument, null);
        }
      }
    }
  }

  return findings;
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
  if (!moduleSpecifier.startsWith(".")) return null;
  const basePath = resolve(dirname(fromFilePath), moduleSpecifier);
  const baseExtension = extname(basePath);
  const extensionlessBasePath = sourceExtensions.has(baseExtension)
    ? basePath.slice(0, -baseExtension.length)
    : basePath;
  const candidates = [
    basePath,
    ...[...sourceExtensions].map((extension) => `${extensionlessBasePath}${extension}`),
    ...[...sourceExtensions].map((extension) => join(extensionlessBasePath, `index${extension}`)),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null;
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

// A Convex function file uses managed IAM when it imports the
// @usehercules/convex SDK (including subpaths such as /iam-management and
// /convex.config) from the canonical convex/iam wiring module, or imports that
// local wiring module from another Convex function.
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
