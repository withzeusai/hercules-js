import type { ESLint, Linter, Rule } from "eslint";
import noEmptySelectValue from "./rules/no-empty-select-value";
import noOutlineButtonColorOverride from "./rules/no-outline-button-color-override";
import requireTypeImportForConvex from "./rules/require-type-import-for-convex";
import * as packageJson from "../package.json";

const NAME = packageJson.name;
const VERSION = packageJson.version;

type TSESLintRule =
  | typeof noEmptySelectValue
  | typeof noOutlineButtonColorOverride
  | typeof requireTypeImportForConvex;
const toESLintRule = (rule: TSESLintRule): Rule.RuleModule =>
  rule as unknown as Rule.RuleModule;

const plugin: ESLint.Plugin = {
  meta: {
    name: NAME,
    version: VERSION,
  },
  rules: {
    "no-empty-select-value": toESLintRule(noEmptySelectValue),
    "no-outline-button-color-override": toESLintRule(
      noOutlineButtonColorOverride,
    ),
    "require-type-import-for-convex": toESLintRule(
      requireTypeImportForConvex,
    ),
  },
};

// Recommended configuration (ESLint 9 flat config format)
// This is the opinionated set of rules for Hercules
const recommendedConfig: Linter.Config = {
  name: "@usehercules/recommended",
  plugins: {
    "@usehercules": plugin,
  },
  rules: {
    // Opinionated rule: SelectItem must not have empty values
    "@usehercules/no-empty-select-value": "error",
    // Opinionated rule: Button with outline variant should not have color overrides
    "@usehercules/no-outline-button-color-override": "error",
    // Opinionated rule: Convex dataModel imports must use 'type' keyword
    "@usehercules/require-type-import-for-convex": "error",
  },
};

// Export configurations
export const configs: Record<string, Linter.Config> = {
  recommended: recommendedConfig,
};

// Export the plugin with all its components
const exportedPlugin: ESLint.Plugin & { configs: typeof configs } = {
  ...plugin,
  configs,
};

// Named exports for ESM
export { noEmptySelectValue, noOutlineButtonColorOverride, requireTypeImportForConvex };
export const rules: Record<string, Rule.RuleModule> = plugin.rules || {};
export const meta = plugin.meta;

// Default export for compatibility
export default exportedPlugin;
