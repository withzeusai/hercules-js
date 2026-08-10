import { realpath } from "fs/promises";
import path from "path";

/**
 * Component IDs are attacker-reachable: they arrive in the body of a POST to
 * the dev server and are turned into a file path that gets read, rewritten, or
 * had elements deleted from it. Everything in here exists to make sure that
 * path stays inside the project and points at a file the tagger could actually
 * have produced an ID for.
 */

/** Extensions the component tagger emits IDs for (see component-tagger.ts). */
const EDITABLE_EXTENSIONS = new Set([".jsx", ".tsx"]);

const COMPONENT_ID_PATTERN = /^(.+):(\d+):(\d+)$/;

export interface ResolvedComponentId {
  /** Absolute path, guaranteed to be inside `rootDir` */
  filePath: string;
  /** 1-based, as emitted by Babel */
  line: number;
  /** 0-based, as emitted by Babel */
  column: number;
}

export type ComponentIdResolution =
  | { ok: true; value: ResolvedComponentId }
  | { ok: false; error: string };

/** True when `target` sits strictly inside `root`. */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Parse a `path/to/file.tsx:line:col` component ID and resolve it to an
 * absolute path inside `rootDir`.
 *
 * Rejects absolute paths, traversal outside the root, and any file the tagger
 * would not have tagged. The lexical checks run first so a hostile ID is
 * refused before touching the filesystem; the path is then canonicalized,
 * because a symlink inside the root can still point outside it.
 */
export async function resolveComponentId(
  componentId: unknown,
  rootDir: string,
): Promise<ComponentIdResolution> {
  if (typeof componentId !== "string" || componentId === "") {
    return { ok: false, error: "Component ID must be a non-empty string" };
  }

  // A NUL byte truncates the path inside libc, so `foo.tsx\0../../etc` could
  // pass the checks below and still open a different file.
  if (componentId.includes("\0")) {
    return { ok: false, error: "Invalid component ID" };
  }

  const match = componentId.match(COMPONENT_ID_PATTERN);
  if (!match) {
    return { ok: false, error: `Invalid component ID format: ${componentId}` };
  }

  const [, relativePath, lineStr, colStr] = match;
  if (!relativePath) {
    return { ok: false, error: `Invalid component ID format: ${componentId}` };
  }

  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    return { ok: false, error: "Component ID must be a project-relative path" };
  }

  const resolvedRoot = path.resolve(rootDir);
  const filePath = path.resolve(resolvedRoot, relativePath);

  // path.resolve collapses `..`, so compare the result against the root rather
  // than scanning the input for traversal sequences.
  if (!isInside(resolvedRoot, filePath)) {
    return { ok: false, error: "Component ID resolves outside the project root" };
  }

  if (!EDITABLE_EXTENSIONS.has(path.extname(filePath))) {
    return { ok: false, error: "Component ID must point at a .jsx or .tsx file" };
  }

  const line = Number.parseInt(lineStr!, 10);
  const column = Number.parseInt(colStr!, 10);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 0) {
    return { ok: false, error: `Invalid location in component ID: ${componentId}` };
  }

  // The checks above are lexical, so `link/App.tsx` passes them while `link` is
  // a symlink pointing out of the project — and readFile/writeFile would follow
  // it. Compare canonical paths, which package-manager and workspace symlinks
  // make a realistic concern.
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }

  let realFilePath: string;
  try {
    realFilePath = await realpath(filePath);
  } catch {
    return { ok: false, error: `Component not found: ${relativePath}` };
  }

  if (!isInside(realRoot, realFilePath)) {
    return { ok: false, error: "Component ID resolves outside the project root" };
  }

  return { ok: true, value: { filePath: realFilePath, line, column } };
}
