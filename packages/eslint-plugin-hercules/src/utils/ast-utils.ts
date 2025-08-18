import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';
import { Type, TypeChecker, TypeFlags } from 'typescript';

/**
 * Gets the name of a JSX element
 */
export function getJSXElementName(node: TSESTree.JSXOpeningElement): string | null {
  if (node.name.type === 'JSXIdentifier') {
    return node.name.name;
  }
  if (node.name.type === 'JSXMemberExpression') {
    const parts: string[] = [];
    let current: TSESTree.JSXMemberExpression | TSESTree.JSXIdentifier | TSESTree.JSXNamespacedName = node.name;
    
    while (current.type === 'JSXMemberExpression') {
      if (current.property.type === 'JSXIdentifier') {
        parts.unshift(current.property.name);
      }
      current = current.object as TSESTree.JSXMemberExpression | TSESTree.JSXIdentifier;
    }
    
    if (current.type === 'JSXIdentifier') {
      parts.unshift(current.name);
    }
    
    return parts.join('.');
  }
  return null;
}

/**
 * Gets the value of a JSX attribute
 */
export function getJSXAttributeValue(
  attribute: TSESTree.JSXAttribute
): TSESTree.Expression | TSESTree.JSXEmptyExpression | TSESTree.Literal | null {
  if (!attribute.value) {
    return null;
  }
  
  if (attribute.value.type === 'Literal') {
    return attribute.value;
  }
  
  if (attribute.value.type === 'JSXExpressionContainer') {
    return attribute.value.expression;
  }
  
  return null;
}

/**
 * Checks if a function call matches a specific name
 */
export function isFunctionCall(
  node: TSESTree.CallExpression,
  functionName: string
): boolean {
  if (node.callee.type === 'Identifier') {
    return node.callee.name === functionName;
  }
  
  if (node.callee.type === 'MemberExpression' && 
      node.callee.property.type === 'Identifier') {
    return node.callee.property.name === functionName;
  }
  
  return false;
}

/**
 * Gets the type of a node using TypeScript type checker
 */
export function getNodeType(
  context: any,
  node: TSESTree.Node
): Type | undefined {
  const parserServices = ESLintUtils.getParserServices(context);
  const checker = parserServices.program.getTypeChecker();
  const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
  
  if (!tsNode) {
    return undefined;
  }
  
  return checker.getTypeAtLocation(tsNode);
}

/**
 * Checks if a type is a string literal type
 */
export function isStringLiteralType(
  type: Type,
  _checker: TypeChecker
): boolean {
  return !!(type.flags & TypeFlags.StringLiteral);
}

/**
 * Gets the literal value from a string literal type
 */
export function getStringLiteralValue(
  type: Type
): string | undefined {
  if ('value' in type && typeof type.value === 'string') {
    return type.value;
  }
  return undefined;
}

/**
 * Checks if a node is an empty string literal
 */
export function isEmptyStringLiteral(node: TSESTree.Node): boolean {
  return node.type === 'Literal' && 
         typeof node.value === 'string' && 
         node.value === '';
}

/**
 * Gets function parameter information
 */
export interface ParameterInfo {
  name: string;
  index: number;
  type?: Type;
  isOptional: boolean;
}

export function getFunctionParameters(
  context: any,
  node: TSESTree.CallExpression
): ParameterInfo[] | undefined {
  const parserServices = ESLintUtils.getParserServices(context);
  const checker = parserServices.program.getTypeChecker();
  const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
  
  if (!tsNode) {
    return undefined;
  }
  
  const signature = checker.getResolvedSignature(tsNode as any);
  if (!signature) {
    return undefined;
  }
  
  const parameters = signature.getParameters();
  return parameters.map((param, index) => {
    const paramType = checker.getTypeOfSymbolAtLocation(param, tsNode);
    const declarations = param.getDeclarations();
    const isOptional = declarations?.some((decl: any) => 
      decl.questionToken !== undefined
    ) || false;
    
    return {
      name: param.getName(),
      index,
      type: paramType,
      isOptional
    };
  });
}
