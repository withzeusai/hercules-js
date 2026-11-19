/**
 * JSON Schema for Convex validators: how a tool's arguments and result are
 * listed to an MCP client. Used by `tool()` in `./convex`; not exported from
 * the package.
 */
import type { GenericValidator, PropertyValidators } from "convex/values";
import type { JsonSchema } from "./server";

/** A 64-bit integer as it travels in JSON: a decimal string. */
export const INT64_PATTERN = /^-?[0-9]+$/;

/** JSON Schema for a Convex validator, as MCP clients read a tool's input and output. */
export function validatorToJsonSchema(validator: GenericValidator): JsonSchema {
  switch (validator.kind) {
    case "string":
      return { type: "string" };
    case "float64":
      return { type: "number" };
    case "int64":
      return {
        type: "string",
        pattern: INT64_PATTERN.source,
        description: "A 64-bit integer, written as a decimal string",
      };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "bytes":
      return { type: "string", contentEncoding: "base64" };
    case "id":
      return {
        type: "string",
        description: `The id of a document in the "${validator.tableName}" table`,
      };
    case "literal":
      return {
        const: typeof validator.value === "bigint" ? validator.value.toString() : validator.value,
      };
    case "array":
      return { type: "array", items: validatorToJsonSchema(validator.element) };
    case "record":
      return { type: "object", additionalProperties: validatorToJsonSchema(validator.value) };
    case "object":
      return fieldsToJsonSchema(validator.fields);
    case "union":
      return { anyOf: validator.members.map(validatorToJsonSchema) };
    default:
      return {};
  }
}

/** The JSON Schema of an object with these fields: a tool's arguments. */
export function fieldsToJsonSchema(fields: PropertyValidators): JsonSchema {
  const entries = Object.entries(fields);
  return {
    type: "object",
    properties: Object.fromEntries(
      entries.map(([name, field]) => [name, validatorToJsonSchema(field)]),
    ),
    required: entries.filter(([, field]) => field.isOptional !== "optional").map(([name]) => name),
    additionalProperties: false,
  };
}
