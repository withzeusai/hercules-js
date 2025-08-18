import { createRuleTester } from './test-helper';
import rule from '../../src/rules/no-empty-select-value';

const ruleTester = createRuleTester('no-empty-select-value', rule);

const validCases = [
  // Valid SelectItem with non-empty value
  {
    code: `
      <SelectItem value="option1">Option 1</SelectItem>
    `
  },
  {
    code: `
      <SelectItem value="0">Zero</SelectItem>
    `
  },
  {
    code: `
      <SelectItem value={selectedValue}>Dynamic Value</SelectItem>
    `
  },
  {
    code: `
      <SelectItem value={\`option-\${id}\`}>Template Value</SelectItem>
    `
  },
  // Other components are not checked
  {
    code: `
      <Select value="">Empty is OK for Select</Select>
    `
  },
  {
    code: `
      <Option value="">Empty is OK for Option</Option>
    `
  }
];

const invalidCases = [
  // Empty string value
  {
    code: `
      <SelectItem value="">Empty Value</SelectItem>
    `,
    errors: [{
      messageId: 'emptySelectValue'
    }]
  },
  // Missing value prop
  {
    code: `
      <SelectItem>No Value Prop</SelectItem>
    `,
    errors: [{
      messageId: 'missingSelectValue'
    }]
  },
  // Empty template literal
  {
    code: `
      <SelectItem value={\`\`}>Empty Template</SelectItem>
    `,
    errors: [{
      messageId: 'emptySelectValue'
    }]
  },
  // Multiple SelectItems, some invalid
  {
    code: `
      <div>
        <SelectItem value="valid">Valid</SelectItem>
        <SelectItem value="">Invalid</SelectItem>
        <SelectItem>Also Invalid</SelectItem>
      </div>
    `,
    errors: [
      {
        messageId: 'emptySelectValue'
      },
      {
        messageId: 'missingSelectValue'
      }
    ]
  }
];

ruleTester.run(validCases, invalidCases);
