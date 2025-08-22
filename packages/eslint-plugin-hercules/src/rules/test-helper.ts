import { Linter } from "eslint";
import parser from "@typescript-eslint/parser";
import { describe, expect, it } from "vitest";

interface TestCase {
  code: string;
  options?: any[];
  errors?: Array<{
    messageId: string;
    data?: Record<string, any>;
    line?: number;
    column?: number;
  }>;
}

interface RuleModule {
  meta: any;
  create: (context: any) => any;
}

export function createRuleTester(
  ruleName: string,
  rule: RuleModule,
): {
  run: (validCases: TestCase[], invalidCases: TestCase[]) => void;
} {
  const linter = new Linter({ configType: "flat" });

  return {
    run(validCases: TestCase[], invalidCases: TestCase[]) {
      describe(ruleName, () => {
        describe("valid cases", () => {
          validCases.forEach((testCase, index) => {
            it(`valid case ${index + 1}`, () => {
              const config: Linter.Config[] = [
                {
                  plugins: {
                    test: {
                      rules: {
                        [ruleName]: rule,
                      },
                    },
                  },
                  languageOptions: {
                    parser,
                    parserOptions: {
                      ecmaVersion: 2020,
                      sourceType: "module",
                      ecmaFeatures: {
                        jsx: true,
                      },
                    },
                  },
                  rules: {
                    [`test/${ruleName}`]: [
                      "error",
                      ...(testCase.options || []),
                    ],
                  },
                },
              ];

              const messages = linter.verify(testCase.code, config);

              // Should have no errors for valid cases
              expect(messages).toHaveLength(0);
            });
          });
        });

        describe("invalid cases", () => {
          invalidCases.forEach((testCase, index) => {
            it(`invalid case ${index + 1}`, () => {
              const config: Linter.Config[] = [
                {
                  plugins: {
                    test: {
                      rules: {
                        [ruleName]: rule,
                      },
                    },
                  },
                  languageOptions: {
                    parser,
                    parserOptions: {
                      ecmaVersion: 2020,
                      sourceType: "module",
                      ecmaFeatures: {
                        jsx: true,
                      },
                    },
                  },
                  rules: {
                    [`test/${ruleName}`]: [
                      "error",
                      ...(testCase.options || []),
                    ],
                  },
                },
              ];

              const messages = linter.verify(testCase.code, config);

              // Should have the expected number of errors
              expect(messages).toHaveLength(testCase.errors?.length || 0);

              // Check each error matches expected
              testCase.errors?.forEach((expectedError, i) => {
                const actualError = messages[i];
                expect(actualError.ruleId).toBe(`test/${ruleName}`);
                expect(actualError.messageId).toBe(expectedError.messageId);

                if (expectedError.data) {
                  // Check that the message contains the expected data values
                  Object.values(expectedError.data).forEach((value) => {
                    if (
                      typeof value === "string" ||
                      typeof value === "number"
                    ) {
                      expect(actualError.message).toContain(String(value));
                    }
                  });
                }

                if (expectedError.line !== undefined) {
                  expect(actualError.line).toBe(expectedError.line);
                }

                if (expectedError.column !== undefined) {
                  expect(actualError.column).toBe(expectedError.column);
                }
              });
            });
          });
        });
      });
    },
  };
}
