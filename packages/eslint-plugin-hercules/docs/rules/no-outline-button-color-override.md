# no-outline-button-color-override

Disallow text or background color classes on Button components with `variant="outline"`.

## Rule Details

This rule helps maintain consistent styling for outline button variants by preventing the override of their color scheme through Tailwind CSS utility classes.

Outline buttons typically have their own predefined color scheme that includes:
- A transparent or light background
- A colored border
- Text color that matches the border

Adding custom text or background colors through `className` can break this design pattern and lead to inconsistent UI.

## Examples

### ❌ Incorrect

```jsx
// Text color override
<Button variant="outline" className="text-red-500">Click me</Button>

// Background color override
<Button variant="outline" className="bg-blue-500">Click me</Button>

// Mixed with other classes
<Button variant="outline" className="px-4 text-white bg-gray-800 py-2">Click me</Button>

// Template literal with color
<Button variant="outline" className={`text-blue-500 rounded`}>Click me</Button>
```

### ✅ Correct

```jsx
// Outline button without color overrides
<Button variant="outline">Click me</Button>

// Outline button with non-color utility classes
<Button variant="outline" className="px-4 py-2 rounded-lg">Click me</Button>

// Outline button with hover effects (non-color)
<Button variant="outline" className="hover:scale-105 transition-transform">Click me</Button>

// Non-outline variants can have color classes
<Button variant="primary" className="text-white bg-blue-500">Click me</Button>

// Dynamic variant (can't be statically analyzed)
<Button variant={variant} className="text-red-500">Click me</Button>
```

## Detected Tailwind Color Classes

The rule detects the following Tailwind color utility patterns:

### Text Colors
- Pattern: `text-{color}` or `text-{color}-{shade}`
- Colors: slate, gray, zinc, neutral, stone, red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose, white, black, transparent, current, inherit
- Shades: 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950

### Background Colors
- Pattern: `bg-{color}` or `bg-{color}-{shade}`
- Same colors and shades as text colors

## When Not To Use It

If your design system allows or requires color customization for outline buttons, you may want to disable this rule.

## Options

This rule has no configuration options.

## Further Reading

- [Tailwind CSS Colors Documentation](https://tailwindcss.com/docs/customizing-colors)
- [Button Component Best Practices](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
