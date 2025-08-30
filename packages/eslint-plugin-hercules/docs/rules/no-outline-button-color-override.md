# no-outline-button-color-override

Prevents color overrides on outline variant buttons to maintain design consistency.

## Rule Details

Outline buttons have predefined color schemes. This rule disallows Tailwind `text-*` and `bg-*` color classes on `Button` components with `variant="outline"`.

Examples of **incorrect** code:

```jsx
// ❌ Color overrides not allowed
<Button variant="outline" className="text-red-500">Click me</Button>
<Button variant="outline" className="bg-blue-500">Click me</Button>
<Button variant="outline" className="px-4 text-white bg-gray-800">Click me</Button>
```

Examples of **correct** code:

```jsx
// ✅ No color overrides
<Button variant="outline">Click me</Button>
<Button variant="outline" className="px-4 py-2 rounded-lg">Click me</Button>

// ✅ Non-outline variants can have colors
<Button variant="primary" className="text-white bg-blue-500">Click me</Button>
```

**Detected patterns**: `text-{color}(-{shade})?` and `bg-{color}(-{shade})?` for all Tailwind colors.

**Message**: `Button with variant="outline" should not have text or background color classes in className.`
