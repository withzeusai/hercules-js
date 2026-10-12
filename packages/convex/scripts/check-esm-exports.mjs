const publicExports = [
  ["@usehercules/convex", "createAccess"],
  ["@usehercules/convex", "classifyAccessError"],
  ["@usehercules/convex/http", "registerAccessRoutes"],
];

for (const [specifier, exportName] of publicExports) {
  const module = await import(specifier);
  if (typeof module[exportName] !== "function") {
    throw new Error(`${specifier} does not export ${exportName}.`);
  }
}
