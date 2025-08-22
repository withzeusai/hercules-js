import { createRuleTester } from "./test-helper";
import rule from "./no-outline-button-color-override";

const ruleTester = createRuleTester("no-outline-button-color-override", rule);

const validCases = [
  // Button without variant="outline"
  {
    code: `
      <Button className="text-red-500 bg-blue-500">Click me</Button>
    `,
  },
  {
    code: `
      <Button variant="primary" className="text-white bg-blue-500">Click me</Button>
    `,
  },
  {
    code: `
      <Button variant="ghost" className="text-gray-700">Click me</Button>
    `,
  },
  // Button with variant="outline" but no className
  {
    code: `
      <Button variant="outline">Click me</Button>
    `,
  },
  // Button with variant="outline" and non-color classes
  {
    code: `
      <Button variant="outline" className="px-4 py-2 rounded-lg">Click me</Button>
    `,
  },
  {
    code: `
      <Button variant="outline" className="hover:scale-105 transition-transform">Click me</Button>
    `,
  },
  {
    code: `
      <Button variant="outline" className="font-bold uppercase">Click me</Button>
    `,
  },
  // Dynamic variant (can't be statically analyzed)
  {
    code: `
      <Button variant={variant} className="text-red-500">Click me</Button>
    `,
  },
  {
    code: `
      <Button variant={\`\${type}\`} className="bg-blue-500">Click me</Button>
    `,
  },
  // Other components are not checked
  {
    code: `
      <CustomButton variant="outline" className="text-red-500">Click me</CustomButton>
    `,
  },
  {
    code: `
      <button variant="outline" className="text-red-500">Click me</button>
    `,
  },
  // Partial color class names that aren't actual Tailwind colors
  {
    code: `
      <Button variant="outline" className="custom-text-style">Click me</Button>
    `,
  },
  {
    code: `
      <Button variant="outline" className="my-bg-image">Click me</Button>
    `,
  },
];

const invalidCases = [
  // Text color violations
  {
    code: `
      <Button variant="outline" className="text-red-500">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="text-blue-700">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="text-gray-900">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="text-white">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  // Background color violations
  {
    code: `
      <Button variant="outline" className="bg-red-500">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="bg-blue-700">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="bg-gray-100">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="bg-black">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  // Mixed violations with other classes
  {
    code: `
      <Button variant="outline" className="px-4 text-red-500 py-2">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="rounded-lg bg-blue-500 hover:scale-105">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="text-white bg-gray-800 font-bold">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  // Template literal variant
  {
    code: `
      <Button variant={\`outline\`} className="text-red-500">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  // Template literal className with static color
  {
    code: `
      <Button variant="outline" className={\`text-blue-500 px-4\`}>Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className={\`rounded bg-green-300\`}>Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  // All Tailwind color variants
  {
    code: `
      <Button variant="outline" className="text-slate-500">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="text-zinc-400">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="text-emerald-600">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="bg-violet-200">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
  {
    code: `
      <Button variant="outline" className="bg-fuchsia-950">Click me</Button>
    `,
    errors: [
      {
        messageId: "outlineButtonColorOverride",
      },
    ],
  },
];

ruleTester.run(validCases, invalidCases);
