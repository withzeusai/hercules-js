# no-empty-select-value

Enforces non-empty `value` props on `SelectItem` components.

## Rule Details

SelectItem components require non-empty values to work correctly with Radix UI's Select, where empty strings are reserved for clearing selections.

Examples of **incorrect** code:

```jsx
// ❌ Empty or missing values
<SelectItem value="">Choose an option</SelectItem>
<SelectItem>Option without value</SelectItem>
<SelectItem value={``}>Empty template</SelectItem>
```

Examples of **correct** code:

```jsx
// ✅ Valid values
<SelectItem value="option1">Option 1</SelectItem>
<SelectItem value="0">Zero</SelectItem>
<SelectItem value={selectedValue}>Dynamic Value</SelectItem>
<SelectItem value={`option-${id}`}>Template Value</SelectItem>

// ✅ Other components can have empty values
<Select value="">OK for Select</Select>
```

**Messages**: 
- `SelectItem value must not be an empty string`
- `SelectItem must have a value prop`
