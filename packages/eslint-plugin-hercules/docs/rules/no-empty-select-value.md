# no-empty-select-value

Disallow empty string values in SelectItem components.

## Rule Details

This rule enforces that `SelectItem` components must have a non-empty `value` prop. This is required by [Radix UI's Select component](https://www.radix-ui.com/primitives/docs/components/select) because the Select value itself can be set to an empty string to clear the selection and show the placeholder. Having empty string values in SelectItem components would conflict with this behavior.

## Examples

### ❌ Incorrect

```jsx
// Empty string value
<SelectItem value="">Choose an option</SelectItem>

// Missing value prop
<SelectItem>Option without value</SelectItem>

// Empty template literal
<SelectItem value={``}>Empty template</SelectItem>
```

### ✅ Correct

```jsx
// Valid string value
<SelectItem value="option1">Option 1</SelectItem>

// Zero as a string is valid (not empty)
<SelectItem value="0">Zero</SelectItem>

// Dynamic value
<SelectItem value={selectedValue}>Dynamic Value</SelectItem>

// Template literal with content
<SelectItem value={`option-${id}`}>Template Value</SelectItem>

// Other components are not checked
<Select value="">This is OK for Select component</Select>
<Option value="">This is OK for Option component</Option>
```

## Messages

- **emptySelectValue**: `SelectItem value must not be an empty string`
- **missingSelectValue**: `SelectItem must have a value prop`

## Options

This rule has no options.

## When Not To Use It

You should disable this rule if you're using a different select component library that allows empty string values in select items.

## Further Reading

- [Radix UI Select Documentation](https://www.radix-ui.com/primitives/docs/components/select)
