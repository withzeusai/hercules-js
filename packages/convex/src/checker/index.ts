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
  code: "convex_dir_missing" | "raw_exported_convex_builder";
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
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const ignoredDirectories = new Set(["_generated", "node_modules", "dist", ".git"]);
const exemptFileNames = new Set(["access.ts", "access.tsx", "http.ts", "convex.config.ts"]);
const exemptionMarkers = [
  "hercules-access-control: allow-raw-builder",
  "hercules-access-control: allow-raw-builders",
];

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

  const sourceFiles = collectSourceFiles(convexDir);
  const fixedFiles = options.fixAuthenticated
    ? sourceFiles.filter((filePath) => fixSourceFileToAuthenticatedBuilders(filePath, convexDir)).length
    : 0;
  const findings = sourceFiles.flatMap((filePath) => checkSourceFile(cwd, filePath));

  return {
    ok: findings.length === 0,
    convexDir,
    filesChecked: sourceFiles.length,
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
    return `Hercules Access Control check passed (${result.filesChecked} ${fileLabel} checked).${fixedLabel}`;
  }

  const lines = [
    `Hercules Access Control check failed with ${result.findings.length} finding(s):`,
  ];

  for (const finding of result.findings) {
    lines.push(
      `- ${finding.filePath}:${finding.line}:${finding.column} ${finding.message}`,
    );
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

function collectSourceFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const sourceFiles: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        sourceFiles.push(...collectSourceFiles(entryPath));
      }
      continue;
    }

    if (isSourceFile(entryPath) && !exemptFileNames.has(basename(entryPath))) {
      sourceFiles.push(entryPath);
    }
  }

  return sourceFiles.sort((left, right) => left.localeCompare(right));
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

function createSourceFile(filePath: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
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
    return { start: specifier.getFullStart(), end: specifier.getEnd(), text: "" };
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
    return {
      start: previous.getEnd(),
      end: specifier.getEnd(),
      text: "",
    };
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
  const lastImport = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .at(-1);
  if (!lastImport) {
    return { start: 0, end: 0, text: importLine };
  }

  return {
    start: includeTrailingNewline(sourceText, lastImport.getEnd()),
    end: includeTrailingNewline(sourceText, lastImport.getEnd()),
    text: importLine,
  };
}

function findAccessImport(sourceFile: ts.SourceFile, convexDir: string):
  | {
      namedBindings?: ts.NamedImportBindings;
    }
  | null {
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
  const relativePath = normalizePath(relative(dirname(sourceFile.fileName), join(convexDir, "access")));
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function isAccessImport(sourceFile: ts.SourceFile, moduleSpecifier: string, convexDir: string): boolean {
  if (!moduleSpecifier.startsWith(".")) {
    return false;
  }

  return (
    stripKnownModuleExtension(resolve(dirname(sourceFile.fileName), moduleSpecifier)) ===
    join(convexDir, "access")
  );
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

  return {
    builder,
    builderNode: callTarget,
  };
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
    suggestion: `Import from ./access and choose public${builderSuffix}, authenticated${builderSuffix}, or access${builderSuffix}.`,
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
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  );
}

function hasLocalExemption(
  sourceFile: ts.SourceFile,
  sourceText: string,
  declaration: ts.Node,
): boolean {
  const leadingText = sourceText.slice(declaration.getFullStart(), declaration.getStart(sourceFile));
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
    result =
      result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
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
