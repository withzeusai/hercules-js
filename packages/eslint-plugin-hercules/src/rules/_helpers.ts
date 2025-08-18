import { ESLintUtils } from "@typescript-eslint/utils";

export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/withzeusai/hercules-js/blob/main/packages/eslint-plugin-hercules/docs/rules/${name}.md`
);
