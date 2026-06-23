const publicExports = [
  ["@usehercules/convex", "createIam"],
  ["@usehercules/convex/iam-management", "createIamManagementActions"],
  ["@usehercules/convex/iam-service", "createIamServiceActions"],
];

for (const [specifier, exportName] of publicExports) {
  const module = await import(specifier);
  if (typeof module[exportName] !== "function") {
    throw new Error(`${specifier} does not export ${exportName}.`);
  }
}
