import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearCachedAccessTokens } from "../lib/google-auth.mjs";
import { pluginDefinition } from "../definition.mjs";

const DATABASE = "https://firestore.googleapis.com/v1/projects/my-project/databases/(default)";
const ENVIRONMENT = { GOOGLE_ACCESS_TOKEN: "firestore-access-token", FIRESTORE_PROJECT_ID: "my-project" };
const DOCUMENT = { name: "projects/my-project/databases/(default)/documents/users/u1", fields: { name: { stringValue: "Ana" }, visits: { integerValue: "3" } }, createTime: "2026-11-19T10:00:00Z", updateTime: "2026-11-19T11:00:00Z" };

async function runFirestore(operationName, args, { responses = [{ body: DOCUMENT }], environment = ENVIRONMENT, source = "node" } = {}) {
  clearCachedAccessTokens();
  const recordingFetch = createRecordingFetch(responses);
  const runOperation = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  try {
    return { output: await runOperation(operationName, args, { source }), calls: recordingFetch.calls };
  } catch (error) {
    return { error, calls: recordingFetch.calls };
  }
}

test("Google auth files are byte-identical to google-sheets/lib", { skip: existsSync(fileURLToPath(new URL("../../google-sheets/lib", import.meta.url))) ? false : "google-sheets not next to this plugin" }, () => {
  for (const fileName of ["google-auth.mjs", "google-errors.mjs", "google-token-endpoint.mjs", "service-account.mjs"]) {
    const ownCopy = readFileSync(new URL(`../lib/${fileName}`, import.meta.url));
    const original = readFileSync(new URL(`../../google-sheets/lib/${fileName}`, import.meta.url));
    assert.ok(ownCopy.equals(original), `copy google-sheets/lib/${fileName} over firestore/lib/${fileName}`);
  }
});

// operation, args -> method, URL after the database (exact, with query), JSON body
const REQUEST_CASES = [
  ["get_document", { path: "users/u 1", mask: ["name", "address.city"] }, "GET", "/documents/users/u%201?mask.fieldPaths=name&mask.fieldPaths=address.city", undefined],
  ["list_documents", { collection_path: "users/u1/orders", limit: 10, cursor: "tok", order_by: "created desc" }, "GET", "/documents/users/u1/orders?pageSize=10&pageToken=tok&orderBy=created%20desc", undefined],
  [
    "run_query",
    { collection_id: "orders", where: [{ field: "status", op: "==", value: "open" }, { field: "total", op: ">=", value: 100 }, { field: "deleted_at", op: "is_null" }], order_by: ["total desc"], select: ["total"], limit: 5 },
    "POST",
    "/documents:runQuery",
    {
      structuredQuery: {
        from: [{ collectionId: "orders", allDescendants: false }],
        limit: 5,
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "open" } } },
              { fieldFilter: { field: { fieldPath: "total" }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: "100" } } },
              { unaryFilter: { op: "IS_NULL", field: { fieldPath: "deleted_at" } } },
            ],
          },
        },
        orderBy: [{ field: { fieldPath: "total" }, direction: "DESCENDING" }],
        select: { fields: [{ fieldPath: "total" }] },
      },
    },
  ],
  ["run_query", { collection_id: "orders", parent_path: "users/u1", all_descendants: true, where: [{ field: "tags", op: "array-contains", value: "vip" }] }, "POST", "/documents/users/u1:runQuery", { structuredQuery: { from: [{ collectionId: "orders", allDescendants: true }], limit: 100, where: { fieldFilter: { field: { fieldPath: "tags" }, op: "ARRAY_CONTAINS", value: { stringValue: "vip" } } } } }],
  ["create_document", { collection_path: "users", document_id: "u2", fields: { name: "Budi", joined: { timestampValue: "2026-11-19T10:00:00Z" } } }, "POST", "/documents/users?documentId=u2", { fields: { name: { stringValue: "Budi" }, joined: { timestampValue: "2026-11-19T10:00:00Z" } } }],
  ["update_document", { path: "users/u1", fields: { "first name": "Ana", visits: 4 }, delete_fields: ["old"] }, "PATCH", "/documents/users/u1?updateMask.fieldPaths=%60first%20name%60&updateMask.fieldPaths=visits&updateMask.fieldPaths=old&currentDocument.exists=true", { fields: { "first name": { stringValue: "Ana" }, visits: { integerValue: "4" } } }],
  ["update_document", { path: "users/u1", fields: { name: "Ana" }, merge: false, must_exist: false }, "PATCH", "/documents/users/u1", { fields: { name: { stringValue: "Ana" } } }],
  ["delete_document", { path: "users/u1", must_exist: true }, "DELETE", "/documents/users/u1?currentDocument.exists=true", undefined],
];

for (const [operationName, args, method, urlSuffix, json] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args).slice(0, 60)} -> ${method} ${urlSuffix.slice(0, 50)}`, async () => {
    const responses = operationName === "run_query" ? [{ body: [{ document: DOCUMENT }, { readTime: "t" }] }] : [{ body: DOCUMENT }];
    const { calls, error } = await runFirestore(operationName, args, { responses });
    assert.equal(error, undefined, error?.message);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, method);
    assert.equal(calls[0].url, `${DATABASE}${urlSuffix}`);
    assert.deepEqual(calls[0].json, json);
    assert.equal(calls[0].headers.authorization, "Bearer firestore-access-token");
  });
}

test("documents are decoded to plain JSON, or kept typed on request", async () => {
  const { output } = await runFirestore("get_document", { path: "users/u1" });
  assert.deepEqual(output.data, { id: "u1", path: "users/u1", fields: { name: "Ana", visits: 3 }, create_time: "2026-11-19T10:00:00Z", update_time: "2026-11-19T11:00:00Z", truncated: false });
  const typed = await runFirestore("get_document", { path: "users/u1", value_format: "typed" });
  assert.deepEqual(typed.output.data.fields, DOCUMENT.fields);
  const listed = await runFirestore("list_documents", { collection_path: "users" }, { responses: [{ body: { documents: [DOCUMENT], nextPageToken: "next" } }] });
  assert.equal(listed.output.data.documents[0].fields.name, "Ana");
  assert.equal(listed.output.next_cursor, "next");
  const queried = await runFirestore("run_query", { collection_id: "users" }, { responses: [{ body: [{ document: DOCUMENT }, { readTime: "t" }] }] });
  assert.equal(queried.output.data.count, 1);
});

test("results are capped by FIRESTORE_MAX_RESULT_BYTES with a truncated flag", async () => {
  const bigDocument = (id) => ({ ...DOCUMENT, name: `projects/my-project/databases/(default)/documents/users/${id}`, fields: { bio: { stringValue: "x".repeat(800) } } });
  const environment = { ...ENVIRONMENT, FIRESTORE_MAX_RESULT_BYTES: "2000" };
  const listed = await runFirestore("list_documents", { collection_path: "users" }, { environment, responses: [{ body: { documents: [bigDocument("a"), bigDocument("b"), bigDocument("c")], nextPageToken: "next" } }] });
  assert.equal(listed.output.data.documents.length, 2);
  assert.equal(listed.output.data.truncated, true);
  assert.equal(listed.output.data.omitted_count, 1);
  assert.equal(listed.output.next_cursor, "next");
  const queried = await runFirestore("run_query", { collection_id: "users" }, { environment, responses: [{ body: [{ document: bigDocument("a") }, { document: bigDocument("b") }, { document: bigDocument("c") }] }] });
  assert.deepEqual({ count: queried.output.data.count, truncated: queried.output.data.truncated, omitted: queried.output.data.omitted_count }, { count: 2, truncated: true, omitted: 1 });
  const small = await runFirestore("run_query", { collection_id: "users" }, { environment, responses: [{ body: [{ document: DOCUMENT }] }] });
  assert.equal(small.output.data.truncated, false);
  const hugeDocument = { ...bigDocument("a"), fields: { bio: { stringValue: "x".repeat(1500) } } };
  const single = await runFirestore("get_document", { path: "users/a" }, { environment: { ...ENVIRONMENT, FIRESTORE_MAX_RESULT_BYTES: "1000" }, responses: [{ body: hugeDocument }] });
  assert.equal(single.output.data.truncated, true);
  assert.deepEqual(single.output.data.fields, {});
  assert.deepEqual(single.output.data.field_names, ["bio"]);
  const invalid = await runFirestore("get_document", { path: "users/a" }, { environment: { ...ENVIRONMENT, FIRESTORE_MAX_RESULT_BYTES: "12" } });
  assert.equal(invalid.error.kind, "invalid_input");
});

test("agent tools are read-only: create/update need FIRESTORE_TOOL_ALLOW_WRITES=1 and delete is node only", async () => {
  for (const [operationName, args] of [
    ["create_document", { collection_path: "users", fields: { a: 1 } }],
    ["update_document", { path: "users/u1", fields: { a: 1 } }],
  ]) {
    const { error, calls } = await runFirestore(operationName, args, { source: "tool" });
    assert.equal(error.kind, "permission_denied");
    assert.match(error.message, /FIRESTORE_TOOL_ALLOW_WRITES=1/);
    assert.equal(calls.length, 0);
    const allowed = await runFirestore(operationName, args, { source: "tool", environment: { ...ENVIRONMENT, FIRESTORE_TOOL_ALLOW_WRITES: "1" } });
    assert.equal(allowed.error, undefined);
  }
  const deleted = await runFirestore("delete_document", { path: "users/u1" }, { source: "tool" });
  assert.match(deleted.error.message, /Unknown operation/);
});

test("a create with an unknown outcome is not retried and says how to check; updates are retried", async () => {
  const serverError = { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: "try again" } } };
  const created = await runFirestore("create_document", { collection_path: "users", fields: { a: 1 } }, { responses: [serverError] });
  assert.equal(created.calls.length, 1);
  assert.equal(created.error.retryable, false);
  assert.match(created.error.message, /To check: list_documents or run_query on users/);
  const updated = await runFirestore("update_document", { path: "users/u1", fields: { a: 1 } }, { responses: [serverError, { body: DOCUMENT }] });
  assert.equal(updated.calls.length, 2);
  assert.equal(updated.error, undefined);
});

test("errors map to kinds and the token is redacted", async () => {
  const cases = [
    [401, "UNAUTHENTICATED", "auth_error"],
    [403, "PERMISSION_DENIED", "permission_denied"],
    [404, "NOT_FOUND", "not_found"],
    [409, "ALREADY_EXISTS", "invalid_input"],
    [400, "FAILED_PRECONDITION", "invalid_input"],
  ];
  for (const [status, grpcStatus, kind] of cases) {
    const { error } = await runFirestore("get_document", { path: "users/u1" }, { responses: [{ status, body: { error: { code: status, status: grpcStatus, message: "echo firestore-access-token" } } }] });
    assert.equal(error.kind, kind, grpcStatus);
    assert.doesNotMatch(error.message, /firestore-access-token/);
  }
});

test("bad paths, filters and values are refused before any request", async () => {
  for (const [operationName, args] of [
    ["get_document", { path: "users" }],
    ["get_document", { path: "users/../admin/x" }],
    ["list_documents", { collection_path: "users/u1" }],
    ["create_document", { collection_path: "users", document_id: "a/b", fields: {} }],
    ["create_document", { collection_path: "users", fields: { n: 2 ** 60 } }],
    ["run_query", { collection_id: "a/b" }],
    ["run_query", { collection_id: "orders", where: [{ field: "x", op: "LIKE", value: 1 }] }],
    ["run_query", { collection_id: "orders", where: [{ field: "x", op: "==" }] }],
    ["run_query", { collection_id: "orders", order_by: ["x sideways"] }],
    ["update_document", { path: "users/u1", fields: {}, delete_fields: [] }],
    ["update_document", { path: "users/u1", fields: { a: 1 }, merge: false, delete_fields: ["b"] }],
  ]) {
    const { error, calls } = await runFirestore(operationName, args);
    assert.equal(error?.kind, "invalid_input", `${operationName} ${JSON.stringify(args)}`);
    assert.equal(calls.length, 0);
  }
  const noProject = await runFirestore("get_document", { path: "users/u1" }, { environment: { GOOGLE_ACCESS_TOKEN: "t-value" } });
  assert.match(noProject.error.message, /FIRESTORE_PROJECT_ID/);
});

test("FIRESTORE_DATABASE selects a named database", async () => {
  const { calls } = await runFirestore("get_document", { path: "users/u1" }, { environment: { ...ENVIRONMENT, FIRESTORE_DATABASE: "analytics-db" } });
  assert.equal(calls[0].url, "https://firestore.googleapis.com/v1/projects/my-project/databases/analytics-db/documents/users/u1");
});
