// Test-only module map for convex-test that mirrors the PUBLISHED component
// layout. The component's deployed module root is the directory holding its
// convex.config.ts (src/component), so its modules are "sync", "checks", ... -
// NOT "component/sync". Mounting tests at that same root keeps intra-component
// function references (e.g. the scheduled "sync:expireRoleBinding") resolving
// identically in tests and on a real deployment; a "/src/**" glob would mount
// them under "component/*" and mask path bugs.
// The `import.meta.glob` ambient type lives in test/test-env.d.ts (shared with
// every test); reference it so this file also typechecks under the production
// tsconfig, which does not include that directory.
/// <reference path="./test-env.d.ts" />

const componentFiles = import.meta.glob(["/src/component/**/*.ts", "!/src/component/**/*.test.ts"]);
// convex-test anchors the module root at the directory containing _generated.
const generatedFiles = import.meta.glob(["/src/_generated/**/*.ts"]);

export const componentModules: Record<string, () => Promise<unknown>> = {
  ...generatedFiles,
};
for (const [path, loader] of Object.entries(componentFiles)) {
  componentModules[path.replace("/src/component/", "/src/")] = loader;
}
