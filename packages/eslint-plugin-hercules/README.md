# @usehercules/eslint-plugin

Opinionated ESLint plugin for Hercules with TypeScript support. This plugin provides rules to enforce best practices and prevent common mistakes.

## Installation

```bash
npm install --save-dev @usehercules/eslint-plugin
# or
pnpm add -D @usehercules/eslint-plugin
# or
yarn add -D @usehercules/eslint-plugin
```

### Peer Dependencies

This plugin requires:

- ESLint 9.0.0 or higher
- TypeScript 4.0.0 or higher (for type checking features)
- @typescript-eslint/parser 7.0.0 or higher (for TypeScript support)

## Quick Start

Create an `eslint.config.js` file in your project root:

```javascript
import herculesPlugin from "@usehercules/eslint-plugin";

export default [
  // Use the recommended opinionated configuration
  herculesPlugin.configs.recommended,
];
```

## Philosophy

This plugin is **opinionated** and enforces specific patterns that we believe lead to better, more maintainable code. The recommended configuration is not meant to be heavily customized - it represents our best practices.

## Rules

### `no-empty-select-value` (Opinionated, Non-configurable)

**Always enabled in recommended config.**

Prevents `SelectItem` components from having empty string values, which typically indicate a logic error or poor UX.

```jsx
// ❌ Invalid
<SelectItem value="">Empty Value</SelectItem>
<SelectItem>Missing Value</SelectItem>
<SelectItem value={``}>Empty Template</SelectItem>

// ✅ Valid
<SelectItem value="option1">Option 1</SelectItem>
<SelectItem value="0">Zero</SelectItem>
<SelectItem value={selectedValue}>Dynamic Value</SelectItem>
```

This rule is intentionally non-configurable. If you need empty values in select options, consider using a different component or pattern.

### `no-invalid-function-args`

Validates function arguments based on configured constraints. The recommended config includes sensible defaults for common functions.

**Default Configuration (in recommended):**

```javascript
{
  functions: [
    // Prevent invalid fetch URLs
    {
      name: "fetch",
      arguments: [{ index: 0, notEmpty: true, pattern: "^https?://" }],
    },
    // Prevent null/empty localStorage operations
    {
      name: "setItem",
      arguments: [
        { index: 0, notEmpty: true },
        { index: 1, notNull: true },
      ],
    },
  ];
}
```

#### Examples

```javascript
// ❌ Invalid
fetch(""); // Empty URL
fetch("ftp://example.com"); // Non-HTTP(S) protocol
localStorage.setItem("", "value"); // Empty key
localStorage.setItem("key", null); // Null value

// ✅ Valid
fetch("https://api.example.com");
localStorage.setItem("user", JSON.stringify({ id: 1 }));
```

### `no-invalid-component-props` (Strict mode only)

Available in strict configuration for additional component prop validation.

## Configurations

### Recommended (Opinionated)

The recommended configuration includes our opinionated rules with sensible defaults:

```javascript
import herculesPlugin from "@usehercules/eslint-plugin";

export default [herculesPlugin.configs.recommended];
```

**Includes:**

- `no-empty-select-value`: Error (non-configurable)
- `no-invalid-function-args`: Error (with defaults for fetch and localStorage)

### Strict

For teams wanting additional validation:

```javascript
import herculesPlugin from "@usehercules/eslint-plugin";

export default [herculesPlugin.configs.strict];
```

**Includes everything from recommended, plus:**

- More function validations (getItem, removeItem)
- Component prop validation (Button, Input, Form)

### TypeScript

Optimized for TypeScript projects:

```javascript
import herculesPlugin from "@usehercules/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    ...herculesPlugin.configs.typescript,
  },
];
```

## Custom Configuration

While we recommend using our opinionated defaults, you can customize if needed:

```javascript
import herculesPlugin from "@usehercules/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@usehercules": herculesPlugin,
    },
    rules: {
      // Opinionated rule - not configurable
      "@usehercules/no-empty-select-value": "error",

      // Add your own function validations
      "@usehercules/no-invalid-function-args": [
        "error",
        {
          functions: [
            {
              name: "myCustomFunction",
              arguments: [{ index: 0, notEmpty: true, minLength: 3 }],
            },
          ],
        },
      ],
    },
  },
];
```

## TypeScript Support

Both rules support TypeScript type checking when used with `@typescript-eslint/parser`. The rules will validate types at compile time for better accuracy.

## Future Expansion

We plan to add more opinionated rules for common component patterns and function usage. The goal is to catch common mistakes early and enforce consistent patterns across Hercules projects.

## Contributing

This plugin is intentionally opinionated. If you find a pattern that should be enforced or prevented, please open an issue with a clear use case and examples.

## License

MIT
