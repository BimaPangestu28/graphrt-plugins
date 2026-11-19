import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { hashPayload, signRequestHeaders } from "../lib/aws-sigv4.mjs";
import { encodeCursor } from "../lib/attribute-values.mjs";
import { createPluginDefinition } from "../definition.mjs";

const FIXED_NOW = new Date("2026-11-19T10:00:00Z");
const SECRET_KEY = "dynamo-secret-key-value";
const SESSION_TOKEN = "dynamo-session-token-value";
const ENVIRONMENT = { AWS_ACCESS_KEY_ID: "AKIADYNAMO", AWS_SECRET_ACCESS_KEY: SECRET_KEY, AWS_REGION: "ap-southeast-1" };

async function runDynamo(operationName, args, { responses = [{ body: {} }], environment = ENVIRONMENT, source = "node" } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(createPluginDefinition({ now: () => FIXED_NOW, retryBaseDelayMs: 1 }), environment, { fetchImpl: recordingFetch });
  try {
    return { output: await runOperation(operationName, args, { source }), calls: recordingFetch.calls };
  } catch (error) {
    return { error, calls: recordingFetch.calls };
  }
}

const dynamoError = (status, type, message = "details") => ({ status, body: { __type: `com.amazonaws.dynamodb.v20120810#${type}`, message } });

// operation, args -> X-Amz-Target action and exact JSON payload
const REQUEST_CASES = [
  ["list_tables", { limit: 10, cursor: "orders" }, "ListTables", { Limit: 10, ExclusiveStartTableName: "orders" }],
  ["describe_table", { table: "orders" }, "DescribeTable", { TableName: "orders" }],
  ["get_item", { table: "orders", key: { pk: "o#1", sk: 2 }, consistent_read: true, projection_expression: "#t", expression_attribute_names: { "#t": "total" } }, "GetItem", { TableName: "orders", Key: { pk: { S: "o#1" }, sk: { N: "2" } }, ConsistentRead: true, ProjectionExpression: "#t", ExpressionAttributeNames: { "#t": "total" } }],
  [
    "query",
    { table: "orders", key_condition_expression: "pk = :pk AND begins_with(sk, :p)", expression_attribute_values: { ":pk": "c#1", ":p": "2026" }, index_name: "by-customer", scan_index_forward: false, limit: 5, cursor: encodeCursor({ pk: { S: "c#1" }, sk: { S: "2026-01" } }) },
    "Query",
    { TableName: "orders", IndexName: "by-customer", ConsistentRead: false, Limit: 5, ExclusiveStartKey: { pk: { S: "c#1" }, sk: { S: "2026-01" } }, ExpressionAttributeValues: { ":pk": { S: "c#1" }, ":p": { S: "2026" } }, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ScanIndexForward: false },
  ],
  ["scan", { table: "orders", filter_expression: "#s = :s", expression_attribute_names: { "#s": "status" }, expression_attribute_values: { ":s": "open" } }, "Scan", { TableName: "orders", FilterExpression: "#s = :s", ConsistentRead: false, Limit: 100, ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": { S: "open" } } }],
  ["batch_get_items", { table: "orders", keys: [{ pk: "a" }, { pk: "b" }] }, "BatchGetItem", { RequestItems: { orders: { Keys: [{ pk: { S: "a" } }, { pk: { S: "b" } }], ConsistentRead: false } } }],
  ["put_item", { table: "orders", item: { pk: "o#2", total: 9.5, tags: ["x"] }, condition_expression: "attribute_not_exists(pk)", return_old_item: true }, "PutItem", { TableName: "orders", ConditionExpression: "attribute_not_exists(pk)", Item: { pk: { S: "o#2" }, total: { N: "9.5" }, tags: { L: [{ S: "x" }] } }, ReturnValues: "ALL_OLD" }],
  ["update_item", { table: "orders", key: { pk: "o#2" }, update_expression: "SET #s = :s", expression_attribute_names: { "#s": "status" }, expression_attribute_values: { ":s": "paid" } }, "UpdateItem", { TableName: "orders", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": { S: "paid" } }, Key: { pk: { S: "o#2" } }, UpdateExpression: "SET #s = :s", ReturnValues: "ALL_NEW" }],
  ["delete_item", { table: "orders", key: { pk: { S: "o#2" } }, attribute_format: "typed" }, "DeleteItem", { TableName: "orders", Key: { pk: { S: "o#2" } } }],
];

for (const [operationName, args, action, expectedPayload] of REQUEST_CASES) {
  test(`${operationName} sends ${action}`, async () => {
    const { calls, error } = await runDynamo(operationName, args);
    assert.equal(error, undefined, error?.message);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://dynamodb.ap-southeast-1.amazonaws.com/");
    assert.equal(calls[0].headers["x-amz-target"], `DynamoDB_20120810.${action}`);
    assert.equal(calls[0].headers["content-type"], "application/x-amz-json-1.0");
    assert.deepEqual(calls[0].json, expectedPayload);
  });
}

test("requests are SigV4-signed for the dynamodb service over the exact body", async () => {
  const { calls } = await runDynamo("describe_table", { table: "orders" }, { environment: { ...ENVIRONMENT, AWS_SESSION_TOKEN: SESSION_TOKEN } });
  const { authorization, "x-amz-date": amzDate, "x-amz-security-token": token, ...unsignedHeaders } = calls[0].headers;
  assert.equal(amzDate, "20261119T100000Z");
  assert.equal(token, SESSION_TOKEN);
  const expected = signRequestHeaders({ method: "POST", url: calls[0].url, headers: unsignedHeaders, payloadHash: hashPayload(calls[0].body), credentials: { accessKeyId: "AKIADYNAMO", secretAccessKey: SECRET_KEY, sessionToken: SESSION_TOKEN }, region: "ap-southeast-1", service: "dynamodb", now: FIXED_NOW });
  assert.equal(authorization, expected.authorization);
  assert.match(authorization, /Credential=AKIADYNAMO\/20261119\/ap-southeast-1\/dynamodb\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date;x-amz-security-token;x-amz-target,/);
});

test("DYNAMODB_ENDPOINT targets DynamoDB Local; only https or local http origins are accepted", async () => {
  const local = await runDynamo("list_tables", {}, { environment: { ...ENVIRONMENT, DYNAMODB_ENDPOINT: "http://localhost:8000" } });
  assert.equal(local.calls[0].url, "http://localhost:8000/");
  for (const endpoint of ["http://dynamo.example.com", "https://x.example.com/path", "not a url"]) {
    const { error, calls } = await runDynamo("list_tables", {}, { environment: { ...ENVIRONMENT, DYNAMODB_ENDPOINT: endpoint } });
    assert.equal(error.kind, "invalid_input", endpoint);
    assert.equal(calls.length, 0);
  }
});

test("query decodes items to plain JSON and returns LastEvaluatedKey as next_cursor", async () => {
  const lastKey = { pk: { S: "c#1" }, sk: { S: "2026-02" } };
  const body = { Items: [{ pk: { S: "c#1" }, total: { N: "12.5" }, big: { N: "99999999999999999999" } }], Count: 1, ScannedCount: 3, LastEvaluatedKey: lastKey };
  const { output } = await runDynamo("query", { table: "orders", key_condition_expression: "pk = :pk", expression_attribute_values: { ":pk": "c#1" } }, { responses: [{ body }] });
  assert.deepEqual(output.data, { items: [{ pk: "c#1", total: 12.5, big: "99999999999999999999" }], count: 1, scanned_count: 3 });
  assert.equal(output.next_cursor, encodeCursor(lastKey));
  const typed = await runDynamo("scan", { table: "orders", attribute_format: "typed" }, { responses: [{ body }] });
  assert.deepEqual(typed.output.data.items, body.Items);
});

test("get_item returns null for a missing item; describe_table is summarized", async () => {
  const missing = await runDynamo("get_item", { table: "orders", key: { pk: "none" } }, { responses: [{ body: {} }] });
  assert.deepEqual(missing.output.data, { item: null });
  const table = { TableName: "orders", TableStatus: "ACTIVE", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }], ItemCount: 3, CreationDateTime: 1767225600, BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" }, GlobalSecondaryIndexes: [{ IndexName: "gsi1", KeySchema: [], Projection: { ProjectionType: "ALL" }, IndexStatus: "ACTIVE" }] };
  const described = await runDynamo("describe_table", { table: "orders" }, { responses: [{ body: { Table: table } }] });
  assert.equal(described.output.data.billing_mode, "PAY_PER_REQUEST");
  assert.equal(described.output.data.created_at, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(described.output.data.global_secondary_indexes, [{ name: "gsi1", key_schema: [], projection: "ALL", status: "ACTIVE" }]);
});

test("batch_get_items retries unprocessed keys and returns any left over", async () => {
  const responses = [
    { body: { Responses: { orders: [{ pk: { S: "a" } }] }, UnprocessedKeys: { orders: { Keys: [{ pk: { S: "b" } }] } } } },
    { body: { Responses: { orders: [{ pk: { S: "b" } }] }, UnprocessedKeys: {} } },
  ];
  const { output, calls } = await runDynamo("batch_get_items", { table: "orders", keys: [{ pk: "a" }, { pk: "b" }] }, { responses });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].json, { RequestItems: { orders: { Keys: [{ pk: { S: "b" } }] } } });
  assert.deepEqual(output.data, { items: [{ pk: "a" }, { pk: "b" }], unprocessed_keys: [] });
  const stuck = { body: { Responses: { orders: [] }, UnprocessedKeys: { orders: { Keys: [{ pk: { S: "b" } }] } } } };
  const leftover = await runDynamo("batch_get_items", { table: "orders", keys: [{ pk: "b" }] }, { responses: [stuck, stuck, stuck, stuck] });
  assert.equal(leftover.calls.length, 4);
  assert.deepEqual(leftover.output.data.unprocessed_keys, [{ pk: "b" }]);
});

const ERROR_CASES = [
  [400, "UnrecognizedClientException", "auth_error"],
  [400, "ExpiredTokenException", "auth_error"],
  [403, "InvalidSignatureException", "auth_error"],
  [400, "AccessDeniedException", "permission_denied"],
  [400, "ResourceNotFoundException", "not_found"],
  [400, "ValidationException", "invalid_input"],
  [400, "ConditionalCheckFailedException", "invalid_input"],
];

for (const [status, type, kind] of ERROR_CASES) {
  test(`DynamoDB ${type} maps to ${kind}`, async () => {
    const { error, calls } = await runDynamo("describe_table", { table: "orders" }, { responses: [dynamoError(status, type)] });
    assert.equal(error.kind, kind);
    assert.match(error.message, new RegExp(type));
    assert.equal(calls.length, 1);
  });
}

test("throttling is retried for reads and writes; a write 5xx is not retried and says how to check", async () => {
  const throttled = await runDynamo("put_item", { table: "orders", item: { pk: "a" } }, { responses: [dynamoError(400, "ProvisionedThroughputExceededException"), { body: {} }] });
  assert.equal(throttled.calls.length, 2);
  assert.equal(throttled.error, undefined);
  const serverError = await runDynamo("update_item", { table: "orders", key: { pk: "a" }, update_expression: "ADD n :one", expression_attribute_values: { ":one": 1 } }, { responses: [dynamoError(500, "InternalServerError")] });
  assert.equal(serverError.calls.length, 1);
  assert.equal(serverError.error.retryable, false);
  assert.match(serverError.error.message, /outcome unknown.*To check: get_item/);
  const readError = await runDynamo("get_item", { table: "orders", key: { pk: "a" } }, { responses: [dynamoError(500, "InternalServerError"), { body: {} }] });
  assert.equal(readError.calls.length, 2);
});

test("secrets echoed in errors or data are redacted", async () => {
  const environment = { ...ENVIRONMENT, AWS_SESSION_TOKEN: SESSION_TOKEN };
  const { error } = await runDynamo("describe_table", { table: "orders" }, { responses: [dynamoError(400, "UnrecognizedClientException", `bad ${SECRET_KEY} ${SESSION_TOKEN}`)], environment });
  assert.doesNotMatch(error.message, new RegExp(`${SECRET_KEY}|${SESSION_TOKEN}`));
  const echoed = await runDynamo("get_item", { table: "orders", key: { pk: "a" } }, { responses: [{ body: { Item: { note: { S: SECRET_KEY } } } }], environment });
  assert.deepEqual(echoed.output.data.item, { note: "[redacted]" });
});

test("agent tools are read-only: put/update need DYNAMODB_TOOL_ALLOW_WRITES=1 and delete is node only", async () => {
  for (const [operationName, args] of [
    ["put_item", { table: "orders", item: { pk: "a" } }],
    ["update_item", { table: "orders", key: { pk: "a" }, update_expression: "SET a = :a", expression_attribute_values: { ":a": 1 } }],
  ]) {
    const { error, calls } = await runDynamo(operationName, args, { source: "tool" });
    assert.equal(error.kind, "permission_denied");
    assert.equal(calls.length, 0);
    const allowed = await runDynamo(operationName, args, { source: "tool", environment: { ...ENVIRONMENT, DYNAMODB_TOOL_ALLOW_WRITES: "1" } });
    assert.equal(allowed.error, undefined);
  }
  const deleted = await runDynamo("delete_item", { table: "orders", key: { pk: "a" } }, { source: "tool" });
  assert.match(deleted.error.message, /Unknown operation/);
  const toolToken = await runDynamo("list_tables", { access_token: "EVIL:evil-secret" }, { source: "tool" });
  assert.match(toolToken.calls[0].headers.authorization, /Credential=AKIADYNAMO\//);
});

test("DYNAMODB_ALLOWED_TABLES limits agent tools; table ARNs from tools need to be listed", async () => {
  const environment = { ...ENVIRONMENT, DYNAMODB_ALLOWED_TABLES: "orders, arn:aws:dynamodb:us-east-1:111122223333:table/shared", DYNAMODB_TOOL_ALLOW_WRITES: "1" };
  for (const [operationName, args] of [
    ["describe_table", { table: "users" }],
    ["get_item", { table: "users", key: { pk: "a" } }],
    ["query", { table: "users", key_condition_expression: "pk = :p", expression_attribute_values: { ":p": "a" } }],
    ["scan", { table: "users" }],
    ["batch_get_items", { table: "users", keys: [{ pk: "a" }] }],
    ["put_item", { table: "users", item: { pk: "a" } }],
    ["update_item", { table: "users", key: { pk: "a" }, update_expression: "SET a = :a", expression_attribute_values: { ":a": 1 } }],
    ["scan", { table: "arn:aws:dynamodb:us-east-1:999999999999:table/orders" }],
  ]) {
    const { error, calls } = await runDynamo(operationName, args, { source: "tool", environment });
    assert.equal(error?.kind, "permission_denied", `${operationName} ${JSON.stringify(args)}`);
    assert.match(error.message, /DYNAMODB_ALLOWED_TABLES/);
    assert.equal(calls.length, 0);
  }
  for (const table of ["orders", "arn:aws:dynamodb:us-east-1:111122223333:table/shared"]) {
    const allowed = await runDynamo("scan", { table }, { source: "tool", environment });
    assert.equal(allowed.error, undefined, table);
  }
  const node = await runDynamo("scan", { table: "users" }, { environment });
  assert.equal(node.error, undefined);
  const unlistedArn = await runDynamo("scan", { table: "arn:aws:dynamodb:us-east-1:999999999999:table/orders" }, { source: "tool" });
  assert.equal(unlistedArn.error.kind, "permission_denied");
  const listed = await runDynamo("list_tables", {}, { source: "tool", environment, responses: [{ body: { TableNames: ["orders", "users"] } }] });
  assert.deepEqual(listed.output.data.table_names, ["orders"]);
});

test("bad input is refused before any request", async () => {
  for (const [operationName, args] of [
    ["describe_table", { table: "a/b" }],
    ["query", { table: "orders", key_condition_expression: "pk = :pk", expression_attribute_values: { pk: "missing colon" } }],
    ["scan", { table: "orders", expression_attribute_names: { status: "status" } }],
    ["scan", { table: "orders", cursor: "garbage" }],
    ["put_item", { table: "orders", item: { pk: 2 ** 60 } }],
    ["put_item", { table: "orders", item: { pk: "plain" }, attribute_format: "typed" }],
    ["batch_get_items", { table: "orders", keys: [] }],
  ]) {
    const { error, calls } = await runDynamo(operationName, args);
    assert.equal(error?.kind, "invalid_input", `${operationName} ${JSON.stringify(args)}`);
    assert.equal(calls.length, 0);
  }
  const missingCredentials = await runDynamo("list_tables", {}, { environment: {} });
  assert.equal(missingCredentials.error.kind, "auth_error");
});
