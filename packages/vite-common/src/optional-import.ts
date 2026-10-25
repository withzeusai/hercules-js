export function isModuleNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    (typeof message === "string" && /Cannot find (module|package)/.test(message))
  );
}

export interface ImportOptionalOptions {
  /** Whether vite.config.ts configured the package explicitly. */
  explicit: boolean;
  /** The package whose name prefixes the error and the warning. */
  owner: string;
}

/**
 * Import an optional peer. When the user configured it explicitly a missing
 * package is an error; otherwise it is skipped with a warning so an app that
 * dropped the dependency on purpose still starts.
 */
export async function importOptional<T>(
  specifier: string,
  load: () => Promise<T>,
  { explicit, owner }: ImportOptionalOptions,
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    if (!isModuleNotFound(error)) throw error;
    if (explicit) {
      throw new Error(
        `[${owner}] \`${specifier}\` is configured in vite.config.ts but is not installed. Add it to devDependencies.`,
        { cause: error },
      );
    }
    console.warn(`[${owner}] \`${specifier}\` is not installed; skipping it.`);
    return undefined;
  }
}
