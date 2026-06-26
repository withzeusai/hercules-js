const publicExports = [
  ["@usehercules/convex", "createIam"],
  ["@usehercules/convex/iam-helpers", "createResourceCreatorBootstrapAction"],
  ["@usehercules/convex/http", "registerIamRoutes"],
];

for (const [specifier, exportName] of publicExports) {
  const module = await import(specifier);
  if (typeof module[exportName] !== "function") {
    throw new Error(`${specifier} does not export ${exportName}.`);
  }
}
