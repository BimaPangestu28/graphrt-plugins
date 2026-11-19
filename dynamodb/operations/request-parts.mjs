/**
 * Parameter schemas and request-building helpers shared by the dynamodb operations.
 *
 * Expressions are passed to DynamoDB as written; values always travel separately in ExpressionAttributeValues
 * and names in ExpressionAttributeNames, so user data is never spliced into an expression.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { marshallItem } from "../lib/attribute-values.mjs";
import { TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";

const TABLE_NAME_PATTERN = /^[A-Za-z0-9_.-]{3,255}$/;
const TABLE_ARN_PATTERN = /^arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:\d{12}:table\/[A-Za-z0-9_.-]{3,255}$/;
const PLACEHOLDER_NAME_PATTERN = /^#[A-Za-z0-9_]+$/;
const PLACEHOLDER_VALUE_PATTERN = /^:[A-Za-z0-9_]+$/;

export const TABLE_PROPERTY = { type: "string", minLength: 3, description: "Table name (or table ARN)" };
export const ATTRIBUTE_FORMAT_PROPERTY = {
  type: "string",
  enum: ["plain", "typed"],
  default: "plain",
  description: "plain: ordinary JSON values; typed: DynamoDB JSON such as {\"S\": \"x\"}, {\"SS\": [..]}, {\"N\": \"1.50\"} (sets, binary, exact numbers)",
};
export const NAMES_PROPERTY = { type: "object", description: "ExpressionAttributeNames, e.g. {\"#s\": \"status\"}" };
export const VALUES_PROPERTY = { type: "object", description: "ExpressionAttributeValues, e.g. {\":s\": \"open\"} (in attribute_format)" };
export const KEY_PROPERTY = { type: "object", description: "Primary key, e.g. {\"pk\": \"user#1\", \"sk\": \"profile\"} (in attribute_format)" };

/**
 * Checks a table name or ARN.
 *
 * @param table - Table argument (string)
 * @returns The table name (string)
 * @throws PluginError kind `invalid_input`
 */
export function checkTableName(table) {
  if (!TABLE_NAME_PATTERN.test(table) && !TABLE_ARN_PATTERN.test(table)) {
    throw new PluginError(`Invalid table name ${JSON.stringify(table)}: 3-255 letters, digits, "_", "-" or "."`, { kind: "invalid_input" });
  }
  return table;
}

/**
 * Builds ExpressionAttributeNames / ExpressionAttributeValues from the arguments, after checking placeholders.
 *
 * @param args - Validated arguments (object)
 * @returns `{ExpressionAttributeNames?, ExpressionAttributeValues?}` (object)
 * @throws PluginError kind `invalid_input` - Placeholders without "#" / ":" or values that cannot be encoded
 */
export function buildExpressionParts(args) {
  const parts = {};
  if (args.expression_attribute_names !== undefined) {
    for (const [placeholder, attributeName] of Object.entries(args.expression_attribute_names)) {
      if (!PLACEHOLDER_NAME_PATTERN.test(placeholder) || typeof attributeName !== "string" || attributeName === "") {
        throw new PluginError(`expression_attribute_names: ${JSON.stringify(placeholder)} must look like "#name" and map to an attribute name`, { kind: "invalid_input" });
      }
    }
    parts.ExpressionAttributeNames = args.expression_attribute_names;
  }
  if (args.expression_attribute_values !== undefined) {
    const badPlaceholder = Object.keys(args.expression_attribute_values).find((placeholder) => !PLACEHOLDER_VALUE_PATTERN.test(placeholder));
    if (badPlaceholder !== undefined) throw new PluginError(`expression_attribute_values: ${JSON.stringify(badPlaceholder)} must look like ":value"`, { kind: "invalid_input" });
    parts.ExpressionAttributeValues = marshallItem(args.expression_attribute_values, args.attribute_format, "expression_attribute_values");
  }
  return parts;
}

/**
 * Refuses a write from an agent tool unless DYNAMODB_TOOL_ALLOW_WRITES=1.
 *
 * @param context - Operation context `{source, client}` (object)
 * @param operationName - For the message (string)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolWriteAllowed({ source, client }, operationName) {
  if (source !== "tool" || client.settings.allowToolWrites) return;
  throw new PluginError(`\`${operationName}\` is disabled for agent tools; set ${TOOL_WRITES_VARIABLE}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
}

/**
 * Refuses an agent tool call on a table outside DYNAMODB_ALLOWED_TABLES (when set). A table ARN (possibly another
 * account's table) is refused for tools unless it is listed there.
 *
 * @param context - Operation context `{source, client, args}` (object)
 * @throws PluginError kind `permission_denied`
 */
export function assertToolTableAllowed({ source, client, args }) {
  if (source !== "tool" || args.table === undefined) return;
  const allowedTables = client.settings.allowedTables;
  const isListed = allowedTables?.has(args.table) ?? false;
  if (isListed || (!allowedTables && !args.table.startsWith("arn:"))) return;
  throw new PluginError(`Table ${JSON.stringify(args.table)} is not in DYNAMODB_ALLOWED_TABLES for agent tools (table ARNs must be listed there); use a workflow node or add it`, { kind: "permission_denied" });
}

/**
 * Drops undefined fields from a request payload.
 *
 * @param payload - Request payload (object)
 * @returns The payload without undefined fields (object)
 */
export function compactPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, fieldValue]) => fieldValue !== undefined));
}
