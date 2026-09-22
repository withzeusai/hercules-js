import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Component path must stay inside the project root");
  }
}

/** Resolve existing component files without allowing traversal or escaping symlinks. */
function resolveRelativePath(rootDir: string, relativePath: string): string {
  if (
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new Error("Component path must be relative to the project root");
  }
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, relativePath);
  assertWithinRoot(root, candidate);
  return candidate;
}

export async function resolveComponentPath(rootDir: string, relativePath: string): Promise<string> {
  const root = path.resolve(rootDir);
  const candidate = resolveRelativePath(root, relativePath);
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  assertWithinRoot(realRoot, realCandidate);
  return realCandidate;
}

/** Resolve a new component through existing ancestors before creating any directories. */
export async function resolveComponentCreationPath(
  rootDir: string,
  relativePath: string,
): Promise<string> {
  const root = path.resolve(rootDir);
  const candidate = resolveRelativePath(root, relativePath);
  const realRoot = await realpath(root);
  const segments = path.relative(root, candidate).split(path.sep);
  let current = realRoot;
  for (const [index, segment] of segments.entries()) {
    const next = path.join(current, segment);
    try {
      await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.join(current, ...segments.slice(index));
    }
    // A dangling symlink must fail here, rather than being treated as a missing directory.
    current = await realpath(next);
    if (current !== realRoot || index === segments.length - 1) {
      assertWithinRoot(realRoot, current);
    }
  }
  return current;
}
