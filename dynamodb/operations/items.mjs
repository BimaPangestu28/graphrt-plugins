/**
 * Item operations: get, query, scan, batch get (reads) and put, update, delete (writes).
 *
 * Agent tools may read; put_item and update_item need DYNAMODB_TOOL_ALLOW_WRITES=1, delete_item is node only.
 * Query and Scan return one page (at most `limit` items, at most 1 MB as DynamoDB pages it) and a next_cursor.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { sleepUnlessCancelled } from "../lib/shared/sleep.mjs";
import { decodeCursor, encodeCursor, marshallItem, unmarshallItem } from "../lib/attribute-values.mjs";
import { assertToolWriteAllowed, ATTRIBUTE_FORMAT_PROPERTY, buildExpressionParts, checkTableName, compactPayload, KEY_PROPERTY, NAMES_PROPERTY, TABLE_PROPERTY, VALUES_PROPERTY } from "./request-parts.mjs";

const MAX_PAGE_ITEMS = 1000;
const MAX_BATCH_KEYS = 100;
const MAX_UNPROCESSED_RETRIES = 3;
const PAGE_PROPERTIES = {
  limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_ITEMS, default: 100, description: "Maximum items to evaluate per page (DynamoDB Limit)" },
  cursor: { type: "string", description: "next_cursor from the previous call" },
};
const READ_PROPERTIES = {
  projection_expression: { type: "string", description: "Attributes to return, e.g. \"#n, price\"" },
  expression_attribute_names: NAMES_PROPERTY,
  attribute_format: ATTRIBUTE_FORMAT_PROPERTY,
};

function decodeItems(items, attributeFormat) {
  return (items ?? []).map((item) => unmarshallItem(item, attributeFormat));
}

function buildPageRequest(args) {
  return compactPayload({
    TableName: checkTableName(args.table),
    IndexName: args.index_name,
    FilterExpression: args.filter_expression,
    ProjectionExpression: args.projection_expression,
    ConsistentRead: args.consistent_read,
    Limit: args.limit,
    ExclusiveStartKey: args.cursor === undefined ? undefined : decodeCursor(args.cursor),
    ...buildExpressionParts(args),
  });
}

function shapePage(response, attributeFormat) {
  return {
    data: { items: decodeItems(response.Items, attributeFormat), count: response.Count ?? 0, scanned_count: response.ScannedCount ?? 0 },
    next_cursor: encodeCursor(response.LastEvaluatedKey),
  };
}

function buildWriteBase(args) {
  return { TableName: checkTableName(args.table), ConditionExpression: args.condition_expression, ...buildExpressionParts(args) };
}

// A write whose outcome is unknown must not be repeated blindly; say how to check.
async function callWrite(client, action, payload, { signal, checkHint }) {
  try {
    return await client.call(action, compactPayload(payload), { signal, isRead: false });
  } catch (writeError) {
    if (!(writeError instanceof PluginError) || !writeError.message.includes("outcome unknown")) throw writeError;
    throw new PluginError(`${writeError.message}. To check: ${checkHint}`, { kind: writeError.kind, retryable: false });
  }
}

async function batchGet({ client, args, signal }) {
  if (args.keys.length === 0) throw new PluginError("`keys` must contain at least one key", { kind: "invalid_input" });
  const table = checkTableName(args.table);
  const request = compactPayload({
    Keys: args.keys.map((key, index) => marshallItem(key, args.attribute_format, `keys[${index}]`)),
    ProjectionExpression: args.projection_expression,
    ExpressionAttributeNames: buildExpressionParts({ expression_attribute_names: args.expression_attribute_names }).ExpressionAttributeNames,
    ConsistentRead: args.consistent_read,
  });
  let pendingRequest = { [table]: request };
  const items = [];
  for (let attempt = 0; ; attempt += 1) {
    const response = await client.call("BatchGetItem", { RequestItems: pendingRequest }, { signal, isRead: true });
    items.push(...(response.Responses?.[table] ?? []));
    const unprocessed = response.UnprocessedKeys?.[table];
    if (!unprocessed?.Keys?.length || attempt >= MAX_UNPROCESSED_RETRIES) {
      return { items: decodeItems(items, args.attribute_format), unprocessed_keys: decodeItems(unprocessed?.Keys, args.attribute_format) };
    }
    pendingRequest = { [table]: unprocessed };
    await sleepUnlessCancelled(client.unprocessedRetryDelayMs * 2 ** attempt, signal, "Batch get cancelled");
  }
}

export const itemOperations = [
  {
    name: "get_item",
    title: "Get item",
    description: "Read one item by its primary key; data.item is null when it does not exist",
    parameters: {
      type: "object",
      properties: { table: TABLE_PROPERTY, key: KEY_PROPERTY, consistent_read: { type: "boolean", default: false, description: "Strongly consistent read" }, ...READ_PROPERTIES },
      required: ["table", "key"],
    },
    run: async ({ client, args, signal }) => {
      const payload = compactPayload({
        TableName: checkTableName(args.table),
        Key: marshallItem(args.key, args.attribute_format, "key"),
        ConsistentRead: args.consistent_read,
        ProjectionExpression: args.projection_expression,
        ...buildExpressionParts({ expression_attribute_names: args.expression_attribute_names }),
      });
      const response = await client.call("GetItem", payload, { signal, isRead: true });
      return { data: { item: unmarshallItem(response.Item, args.attribute_format) } };
    },
  },
  {
    name: "query",
    title: "Query",
    description: "Query items by partition key (and optional sort key condition) on a table or index, one page with next_cursor",
    parameters: {
      type: "object",
      properties: {
        table: TABLE_PROPERTY,
        key_condition_expression: { type: "string", minLength: 1, description: "e.g. \"pk = :pk AND begins_with(sk, :prefix)\"" },
        expression_attribute_values: VALUES_PROPERTY,
        filter_expression: { type: "string", description: "Filter applied after the key condition (still counts toward reads)" },
        index_name: { type: "string", description: "Global or local secondary index to query" },
        scan_index_forward: { type: "boolean", default: true, description: "false returns the newest (highest sort key) first" },
        consistent_read: { type: "boolean", default: false, description: "Strongly consistent read (not on global indexes)" },
        ...READ_PROPERTIES,
        ...PAGE_PROPERTIES,
      },
      required: ["table", "key_condition_expression"],
    },
    run: async ({ client, args, signal }) => {
      const payload = { ...buildPageRequest(args), KeyConditionExpression: args.key_condition_expression, ScanIndexForward: args.scan_index_forward };
      return shapePage(await client.call("Query", payload, { signal, isRead: true }), args.attribute_format);
    },
  },
  {
    name: "scan",
    title: "Scan",
    description: "Scan a table or index page by page (reads every item: prefer query), with optional filter and next_cursor",
    parameters: {
      type: "object",
      properties: {
        table: TABLE_PROPERTY,
        filter_expression: { type: "string", description: "e.g. \"#s = :open\"" },
        expression_attribute_values: VALUES_PROPERTY,
        index_name: { type: "string", description: "Index to scan" },
        consistent_read: { type: "boolean", default: false, description: "Strongly consistent read" },
        ...READ_PROPERTIES,
        ...PAGE_PROPERTIES,
      },
      required: ["table"],
    },
    run: async ({ client, args, signal }) => shapePage(await client.call("Scan", buildPageRequest(args), { signal, isRead: true }), args.attribute_format),
  },
  {
    name: "batch_get_items",
    title: "Batch get items",
    description: "Read up to 100 items of one table by primary key; unprocessed keys are retried, any left over are returned",
    parameters: {
      type: "object",
      properties: {
        table: TABLE_PROPERTY,
        keys: { type: "array", items: { type: "object" }, maxItems: MAX_BATCH_KEYS, description: "Primary keys, e.g. [{\"pk\": \"a\"}, {\"pk\": \"b\"}]" },
        consistent_read: { type: "boolean", default: false, description: "Strongly consistent reads" },
        ...READ_PROPERTIES,
      },
      required: ["table", "keys"],
    },
    run: async (context) => ({ data: await batchGet(context) }),
  },
  {
    name: "put_item",
    title: "Put item",
    description: "Create or replace an item, optionally only when a condition holds (as an agent tool only when DYNAMODB_TOOL_ALLOW_WRITES=1)",
    parameters: {
      type: "object",
      properties: {
        table: TABLE_PROPERTY,
        item: { type: "object", description: "The whole item including its key, e.g. {\"pk\": \"user#1\", \"name\": \"Ana\"}" },
        condition_expression: { type: "string", description: "e.g. \"attribute_not_exists(pk)\" to never overwrite" },
        expression_attribute_names: NAMES_PROPERTY,
        expression_attribute_values: VALUES_PROPERTY,
        return_old_item: { type: "boolean", default: false, description: "Return the item this put replaced" },
        attribute_format: ATTRIBUTE_FORMAT_PROPERTY,
      },
      required: ["table", "item"],
    },
    run: async (context) => {
      const { client, args, signal } = context;
      assertToolWriteAllowed(context, "put_item");
      const payload = { ...buildWriteBase(args), Item: marshallItem(args.item, args.attribute_format, "item"), ReturnValues: args.return_old_item ? "ALL_OLD" : undefined };
      const response = await callWrite(client, "PutItem", payload, { signal, checkHint: "get_item with the item's key" });
      return { data: { written: true, old_item: unmarshallItem(response.Attributes, args.attribute_format) } };
    },
  },
  {
    name: "update_item",
    title: "Update item",
    description: "Update attributes of one item with an update expression (creates the item if missing unless a condition prevents it; as an agent tool only when DYNAMODB_TOOL_ALLOW_WRITES=1)",
    parameters: {
      type: "object",
      properties: {
        table: TABLE_PROPERTY,
        key: KEY_PROPERTY,
        update_expression: { type: "string", minLength: 1, description: "e.g. \"SET #s = :s, updated_at = :now ADD visits :one\"" },
        condition_expression: { type: "string", description: "e.g. \"attribute_exists(pk)\" to only update existing items" },
        expression_attribute_names: NAMES_PROPERTY,
        expression_attribute_values: VALUES_PROPERTY,
        return_values: { type: "string", enum: ["NONE", "ALL_NEW", "UPDATED_NEW", "ALL_OLD", "UPDATED_OLD"], default: "ALL_NEW", description: "Which attributes to return" },
        attribute_format: ATTRIBUTE_FORMAT_PROPERTY,
      },
      required: ["table", "key", "update_expression"],
    },
    run: async (context) => {
      const { client, args, signal } = context;
      assertToolWriteAllowed(context, "update_item");
      const payload = { ...buildWriteBase(args), Key: marshallItem(args.key, args.attribute_format, "key"), UpdateExpression: args.update_expression, ReturnValues: args.return_values };
      const response = await callWrite(client, "UpdateItem", payload, { signal, checkHint: "get_item with the same key (ADD and list appends are not safe to repeat)" });
      return { data: { updated: true, attributes: unmarshallItem(response.Attributes, args.attribute_format) } };
    },
  },
  {
    name: "delete_item",
    title: "Delete item",
    description: "Delete one item by primary key, optionally only when a condition holds; workflow nodes only",
    nodeOnly: true,
    parameters: {
      type: "object",
      properties: {
        table: TABLE_PROPERTY,
        key: KEY_PROPERTY,
        condition_expression: { type: "string", description: "e.g. \"#s = :done\"" },
        expression_attribute_names: NAMES_PROPERTY,
        expression_attribute_values: VALUES_PROPERTY,
        return_old_item: { type: "boolean", default: false, description: "Return the deleted item" },
        attribute_format: ATTRIBUTE_FORMAT_PROPERTY,
      },
      required: ["table", "key"],
    },
    run: async ({ client, args, signal }) => {
      const payload = { ...buildWriteBase(args), Key: marshallItem(args.key, args.attribute_format, "key"), ReturnValues: args.return_old_item ? "ALL_OLD" : undefined };
      const response = await callWrite(client, "DeleteItem", payload, { signal, checkHint: "get_item with the same key" });
      return { data: { deleted: true, old_item: unmarshallItem(response.Attributes, args.attribute_format) } };
    },
  },
];
