import { realpath } from "node:fs/promises";
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
export async function resolveComponentPath(rootDir: string, relativePath: string): Promise<string> {
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
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  assertWithinRoot(realRoot, realCandidate);
  return realCandidate;
}
