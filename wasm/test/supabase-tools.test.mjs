/**
 * Behaviour parity of the supabase tools in the default tool mode: every case runs against the Node.js plugin
 * (supabase/, with a recording fetch) and the WebAssembly build (wasm/supabase, through wasm-host.mjs with the same
 * responses), and both must give the same result (`text` and `data`), error kind and message, and HTTP requests
 * (method, URL, headers, body).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createOperationRunner, createToolHandler } from "../../supabase/lib/shared/operations.mjs";
import { pluginDefinition } from "../../supabase/definition.mjs";
import { loadWasmPlugin } from "./wasm-host.mjs";

const WASM_DIRECTORY = new URL("../supabase/", import.meta.url);
const wasmPlugin = loadWasmPlugin(fileURLToPath(new URL("supabase.wasm", WASM_DIRECTORY)));
const wasmManifest = JSON.parse(readFileSync(new URL("graphrt-plugin.json", WASM_DIRECTORY), "utf8"));
const nodeManifest = JSON.parse(readFileSync(new URL("../../supabase/graphrt-plugin.json", import.meta.url), "utf8"));

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_0123456789";
const encodePart = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const USER_JWT = `${encodePart({ alg: "HS256" })}.${encodePart({ sub: "user-1", role: "authenticated" })}.c2lnbmF0dXJl`;
const ANON_KEY = `${encodePart({ alg: "HS256" })}.${encodePart({ role: "anon" })}.YW5vbnNpZw`;
const BASE_ENV = { SUPABASE_URL: PROJECT, SUPABASE_KEY: PUBLISHABLE_KEY };
const WRITES = { SUPABASE_TOOL_ALLOW_WRITES: "1" };
const ROWS = Array.from({ length: 12 }, (_, index) => ({ id: index, label: `row ${index}` }));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10]);
const FILE_URL = "https://files.example.com/media/logo.png";
const PUBLIC_ADDRESS = "93.184.216.34";
const UPLOAD = { bucket_id: "public", object_path: "brand/logo.png", file: FILE_URL };
const pngResponse = { bytes: PNG, headers: { "content-type": "image/png; charset=binary" } };

/**
 * Shared cases: `tool`, `args`, `environment` (on top of BASE_ENV), `responses` (`{status?, headers?, body?}`
 * JSON or text, or `{bytes}` for binary), or `transport` ("refused" | "timeout") instead of responses.
 * `kind`/`message` expect an error; `sameMessage: false` only where the text comes from the HTTP stack or the file
 * system; `nodeRetries: true` where Node.js retries (a guest cannot sleep, so it sends once): then only the first
 * request and the final error are compared.
 */
const CASES = [
  // --- select_rows
  { name: "select_rows: a table with the default page size", tool: "select_rows", args: { table: "orders" }, responses: [{ body: ROWS }] },
  {
    name: "select_rows: columns, quoted filters, order, schema and a full page",
    tool: "select_rows",
    args: {
      table: "orders",
      columns: "id,total,customer:profiles(name)",
      filters: [
        { column: "status", operator: "eq", value: 'open,"x"' },
        { column: "data->>city", operator: "in", value: ["Jakarta", 2, true] },
        { column: "deleted_at", operator: "is", value: null, negate: true },
        { column: "body", operator: "wfts", value: "kopi susu", language: "english" },
      ],
      order: " created_at.desc.nullslast , id",
      db_schema: "sales",
      limit: 2,
    },
    responses: [{ body: ROWS.slice(0, 2) }],
  },
  { name: "select_rows: the next page from a cursor", tool: "select_rows", args: { table: "orders", cursor: "2", limit: "2" }, responses: [{ body: ROWS.slice(2, 4) }] },
  { name: "select_rows: a cursor as a number", tool: "select_rows", args: { table: "orders", cursor: 4, limit: 4 }, responses: [{ body: [] }] },
  { name: "select_rows: a bad cursor", tool: "select_rows", args: { table: "orders", cursor: "next" }, kind: "invalid_input", message: /cursor/ },
  { name: "select_rows: filters as JSON text", tool: "select_rows", args: { table: "orders", filters: '[{"column": "id", "operator": "gte", "value": 3}]' }, responses: [{ body: [] }] },
  { name: "select_rows: an injected column", tool: "select_rows", args: { table: "orders", filters: [{ column: "id);drop", operator: "eq", value: 1 }] }, kind: "invalid_input", message: /column name/ },
  { name: "select_rows: a missing column", tool: "select_rows", args: { table: "orders", filters: [{ operator: "eq", value: 1 }] }, kind: "invalid_input", message: /undefined/ },
  { name: "select_rows: an unknown operator", tool: "select_rows", args: { table: "orders", filters: [{ column: "id", operator: "or", value: 1 }] }, kind: "invalid_input", message: /operator/ },
  { name: "select_rows: in without values", tool: "select_rows", args: { table: "orders", filters: [{ column: "id", operator: "in", value: [] }] }, kind: "invalid_input" },
  { name: "select_rows: eq null", tool: "select_rows", args: { table: "orders", filters: [{ column: "id", operator: "eq", value: null }] }, kind: "invalid_input", message: /use operator is/ },
  { name: "select_rows: an object value", tool: "select_rows", args: { table: "orders", filters: [{ column: "id", operator: "eq", value: { a: 1 } }] }, kind: "invalid_input" },
  { name: "select_rows: a language on eq", tool: "select_rows", args: { table: "orders", filters: [{ column: "id", operator: "eq", value: 1, language: "english" }] }, kind: "invalid_input" },
  { name: "select_rows: a filter that is not an object", tool: "select_rows", args: { table: "orders", filters: [1] }, kind: "invalid_input" },
  { name: "select_rows: too many filters", tool: "select_rows", args: { table: "orders", filters: Array.from({ length: 21 }, () => ({ column: "id", operator: "eq", value: 1 })) }, kind: "invalid_input", message: /at most 20/ },
  { name: "select_rows: a bad order", tool: "select_rows", args: { table: "orders", order: "id;select" }, kind: "invalid_input", message: /order/ },
  { name: "select_rows: limit above the maximum", tool: "select_rows", args: { table: "orders", limit: 1001 }, kind: "invalid_input", message: /<= 1000/ },
  { name: "select_rows: limit zero", tool: "select_rows", args: { table: "orders", limit: "0" }, kind: "invalid_input", message: />= 1/ },
  { name: "select_rows: missing table", tool: "select_rows", args: {}, kind: "invalid_input", message: /table/ },
  { name: "select_rows: a dot-dot table", tool: "select_rows", args: { table: ".." }, kind: "invalid_input", message: /Invalid id/ },
  { name: "select_rows: an encoded dot-dot table", tool: "select_rows", args: { table: "%2e%2e" }, kind: "invalid_input", message: /Unsafe API path/ },
  { name: "select_rows: a table name with spaces, slashes and accents", tool: "select_rows", args: { table: "my table/é" }, responses: [{ body: [] }] },
  { name: "select_rows: a numeric table name", tool: "select_rows", args: { table: 42 }, responses: [{ body: [] }] },
  { name: "select_rows: a line break in db_schema", tool: "select_rows", args: { table: "orders", db_schema: "a\r\nx-evil: 1" }, kind: "invalid_input", message: /line breaks/ },
  { name: "select_rows: a huge result becomes a preview", tool: "select_rows", args: { table: "orders" }, responses: [{ body: [{ blob: "é".repeat(60000) + "x".repeat(50000) }] }] },
  { name: "select_rows: text that is not JSON", tool: "select_rows", args: { table: "orders" }, responses: [{ body: "plain text" }] },
  { name: "select_rows: expired JWT (PGRST301)", tool: "select_rows", args: { table: "orders" }, responses: [{ status: 401, body: { code: "PGRST301", message: "JWT expired" } }], kind: "auth_error" },
  { name: "select_rows: unknown table (PGRST205)", tool: "select_rows", args: { table: "nope" }, responses: [{ status: 404, body: { code: "PGRST205", message: "Could not find the table", details: null, hint: null } }], kind: "not_found" },
  { name: "select_rows: row level security (42501)", tool: "select_rows", args: { table: "orders" }, responses: [{ status: 403, body: { code: "42501", message: "permission denied for table orders" } }], kind: "permission_denied" },
  { name: "select_rows: a bad request", tool: "select_rows", args: { table: "orders" }, responses: [{ status: 400, body: { code: "PGRST100", message: "failed to parse filter" } }], kind: "invalid_input" },
  { name: "select_rows: a server error is retried by Node.js", tool: "select_rows", args: { table: "orders" }, responses: [500, 500, 500].map((status) => ({ status, body: { message: "boom" } })), kind: "api_error", nodeRetries: true },
  { name: "select_rows: a refused connection", tool: "select_rows", args: { table: "orders" }, transport: "refused", kind: "network_error", sameMessage: false, nodeRetries: true },
  { name: "select_rows: a legacy anon key is also the Bearer token", tool: "select_rows", args: { table: "orders" }, environment: { SUPABASE_KEY: ANON_KEY }, responses: [{ body: [{ key: ANON_KEY }] }] },
  { name: "select_rows: SUPABASE_USER_JWT is the Bearer token and redacted", tool: "select_rows", args: { table: "orders" }, environment: { SUPABASE_USER_JWT: ` ${USER_JWT} ` }, responses: [{ body: [{ token: USER_JWT, note: `Bearer ${USER_JWT}`, key: PUBLISHABLE_KEY }] }] },
  { name: "select_rows: the key in an error is redacted", tool: "select_rows", args: { table: "orders" }, responses: [{ status: 401, body: { message: `bad key ${PUBLISHABLE_KEY}` } }], kind: "auth_error" },
  { name: "select_rows: no SUPABASE_KEY", tool: "select_rows", args: { table: "orders" }, environment: { SUPABASE_KEY: " " }, kind: "auth_error", message: /SUPABASE_KEY/ },
  { name: "select_rows: no SUPABASE_URL", tool: "select_rows", args: { table: "orders" }, environment: { SUPABASE_URL: "" }, kind: "invalid_input", message: /SUPABASE_URL/ },
  { name: "select_rows: SUPABASE_URL with a path", tool: "select_rows", args: { table: "orders" }, environment: { SUPABASE_URL: `${PROJECT}/rest/v1` }, kind: "invalid_input", message: /origin only/ },
  { name: "select_rows: local http SUPABASE_URL", tool: "select_rows", args: { table: "orders" }, environment: { SUPABASE_URL: "http://localhost:54321" }, responses: [{ body: [] }] },
  { name: "select_rows: arguments are checked before the credential", tool: "select_rows", args: {}, environment: { SUPABASE_KEY: "" }, kind: "invalid_input" },

  // --- get_api_schema
  { name: "get_api_schema: with a schema", tool: "get_api_schema", args: { db_schema: "sales" }, responses: [{ body: { swagger: "2.0", paths: {} } }] },

  // --- insert_rows
  { name: "insert_rows: refused without SUPABASE_TOOL_ALLOW_WRITES", tool: "insert_rows", args: { table: "orders", rows: [{ total: 1 }] }, kind: "permission_denied", message: /SUPABASE_TOOL_ALLOW_WRITES=1/ },
  { name: "insert_rows: SUPABASE_TOOL_ALLOW_WRITES must be exactly 1", tool: "insert_rows", args: { table: "orders", rows: [{ total: 1 }] }, environment: { SUPABASE_TOOL_ALLOW_WRITES: "true" }, kind: "permission_denied" },
  { name: "insert_rows: rows with returned columns and a schema", tool: "insert_rows", args: { table: "orders", rows: [{ total: 1, note: "é" }, { total: 2 }], columns: "id", db_schema: "sales" }, environment: WRITES, responses: [{ status: 201, body: [{ id: 1 }, { id: 2 }] }] },
  { name: "insert_rows: rows as JSON text", tool: "insert_rows", args: { table: "orders", rows: '[{"total": 3}]' }, environment: WRITES, responses: [{ status: 201, body: [{ id: 3 }] }] },
  { name: "insert_rows: rows that are not objects", tool: "insert_rows", args: { table: "orders", rows: [1] }, environment: WRITES, kind: "invalid_input", message: /rows\[0\]/ },
  { name: "insert_rows: a server error says how to check", tool: "insert_rows", args: { table: "orders", rows: [{ total: 1 }] }, environment: WRITES, responses: [{ status: 503, body: { message: "unavailable" } }], kind: "api_error", message: /outcome unknown.*To check: select_rows/ },
  { name: "insert_rows: a refused connection says how to check", tool: "insert_rows", args: { table: "orders", rows: [{ total: 1 }] }, environment: WRITES, transport: "refused", kind: "network_error", message: /outcome unknown.*To check/, sameMessage: false },
  { name: "insert_rows: a conflict", tool: "insert_rows", args: { table: "orders", rows: [{ id: 1 }] }, environment: WRITES, responses: [{ status: 409, body: { code: "23505", message: "duplicate key value" } }], kind: "api_error" },

  // --- upsert_rows
  { name: "upsert_rows: merge on a conflict column", tool: "upsert_rows", args: { table: "profiles", rows: [{ email: "a@b.c" }], on_conflict: "email", columns: "id,email" }, environment: WRITES, responses: [{ body: [{ id: 1 }] }] },
  { name: "upsert_rows: ignore duplicates (case-insensitive enum)", tool: "upsert_rows", args: { table: "profiles", rows: [{ id: 1 }], duplicates: "IGNORE" }, environment: WRITES, responses: [{ body: [] }] },
  { name: "upsert_rows: an unknown duplicates choice", tool: "upsert_rows", args: { table: "profiles", rows: [{ id: 1 }], duplicates: "replace" }, environment: WRITES, kind: "invalid_input", message: /merge, ignore/ },
  { name: "upsert_rows: refused without SUPABASE_TOOL_ALLOW_WRITES", tool: "upsert_rows", args: { table: "profiles", rows: [{ id: 1 }] }, kind: "permission_denied" },

  // --- update_rows
  { name: "update_rows: values on filtered rows", tool: "update_rows", args: { table: "orders", values: { status: "done" }, filters: [{ column: "id", operator: "eq", value: 7 }], columns: "id,status" }, environment: WRITES, responses: [{ body: [{ id: 7, status: "done" }] }] },
  { name: "update_rows: no filters", tool: "update_rows", args: { table: "orders", values: { status: "done" } }, environment: WRITES, kind: "invalid_input", message: /filters/ },
  { name: "update_rows: an empty filter list", tool: "update_rows", args: { table: "orders", values: { status: "done" }, filters: [] }, environment: WRITES, kind: "invalid_input", message: /at least one filter/ },
  { name: "update_rows: filters are checked before the write policy", tool: "update_rows", args: { table: "orders", values: { a: 1 }, filters: [{ column: "bad column", operator: "eq", value: 1 }] }, kind: "invalid_input" },
  { name: "update_rows: refused without SUPABASE_TOOL_ALLOW_WRITES", tool: "update_rows", args: { table: "orders", values: { a: 1 }, filters: [{ column: "id", operator: "eq", value: 1 }] }, kind: "permission_denied" },
  { name: "update_rows: values must be an object", tool: "update_rows", args: { table: "orders", values: [1], filters: [{ column: "id", operator: "eq", value: 1 }] }, environment: WRITES, kind: "invalid_input" },

  // --- call_function (default mode)
  { name: "call_function: any function without an allowlist", tool: "call_function", args: { function_name: "get_stats", arguments: { days: 7 }, db_schema: "sales" }, environment: WRITES, responses: [{ body: { total: 10 } }] },
  { name: "call_function: default arguments", tool: "call_function", args: { function_name: "ping" }, environment: WRITES, responses: [{ status: 204 }] },
  { name: "call_function: a name with a slash stays one segment", tool: "call_function", args: { function_name: "a/b" }, environment: WRITES, responses: [{ body: 1 }] },
  { name: "call_function: refused without SUPABASE_TOOL_ALLOW_WRITES", tool: "call_function", args: { function_name: "ping" }, kind: "permission_denied", message: /SUPABASE_TOOL_ALLOW_WRITES/ },
  { name: "call_function: the allowlist is checked first", tool: "call_function", args: { function_name: "drop_all" }, environment: { SUPABASE_TOOL_RPC_ALLOWLIST: "ping" }, kind: "permission_denied", message: /Allowed functions: ping/ },
  { name: "call_function: an allowed function", tool: "call_function", args: { function_name: "ping" }, environment: { ...WRITES, SUPABASE_TOOL_RPC_ALLOWLIST: "ping, pong" }, responses: [{ body: "pong" }] },
  { name: "call_function: rows cut to SUPABASE_TOOL_MAX_ROWS", tool: "call_function", args: { function_name: "list" }, environment: { ...WRITES, SUPABASE_TOOL_MAX_ROWS: "5" }, responses: [{ body: ROWS }] },
  { name: "call_function: a bad SUPABASE_TOOL_TIMEOUT_MS", tool: "call_function", args: { function_name: "ping" }, environment: { ...WRITES, SUPABASE_TOOL_TIMEOUT_MS: "1s" }, kind: "invalid_input", message: /SUPABASE_TOOL_TIMEOUT_MS/ },
  { name: "call_function: a slow function", tool: "call_function", args: { function_name: "slow" }, environment: { ...WRITES, SUPABASE_TOOL_TIMEOUT_MS: "1000" }, transport: "timeout", kind: "timeout", message: /1000 ms \(SUPABASE_TOOL_TIMEOUT_MS\)/ },
  { name: "call_function: a server error says how to check", tool: "call_function", args: { function_name: "ping" }, environment: WRITES, responses: [{ status: 500, body: { message: "boom" } }], kind: "api_error", message: /To check: read the rows the function changes/ },
  { name: "call_function: an unknown function (PGRST202)", tool: "call_function", args: { function_name: "nope" }, environment: WRITES, responses: [{ status: 404, body: { code: "PGRST202", message: "Could not find the function" } }], kind: "not_found" },

  // --- storage reads
  { name: "list_buckets", tool: "list_buckets", args: {}, responses: [{ body: [{ id: "avatars", public: true }] }] },
  { name: "get_bucket: an id that needs encoding", tool: "get_bucket", args: { bucket_id: "team files" }, responses: [{ body: { id: "team files" } }] },
  { name: "get_bucket: unknown bucket", tool: "get_bucket", args: { bucket_id: "nope" }, responses: [{ status: 400, body: { statusCode: "404", error: "Bucket not found", code: "NoSuchBucket", message: "Bucket not found" } }], kind: "not_found" },
  { name: "get_object_info: a nested path", tool: "get_object_info", args: { bucket_id: "docs", object_path: "invoices/2026/11 é.pdf" }, responses: [{ body: { size: 10 } }] },
  { name: "get_object_info: an empty segment", tool: "get_object_info", args: { bucket_id: "docs", object_path: "a//b" }, kind: "invalid_input", message: /Invalid id ""/ },
  { name: "get_object_info: a dot-dot segment", tool: "get_object_info", args: { bucket_id: "docs", object_path: "../secret" }, kind: "invalid_input", message: /Invalid id/ },
  { name: "list_objects: the root with the default page size", tool: "list_objects", args: { bucket_id: "docs" }, responses: [{ body: [{ name: "a.pdf" }] }] },
  { name: "list_objects: search, sort and the next page", tool: "list_objects", args: { bucket_id: "docs", prefix: "invoices/2026", search: "nov", sort_column: "created_at", sort_order: "DESC", cursor: "10", limit: 2 }, responses: [{ body: [{ name: "a" }, { name: "b" }] }] },
  { name: "list_objects: an unknown sort column", tool: "list_objects", args: { bucket_id: "docs", sort_column: "size" }, kind: "invalid_input" },

  // --- upload_object
  { name: "upload_object: a binary file from an https URL", tool: "upload_object", args: { ...UPLOAD, cache_control: "max-age=3600" }, environment: WRITES, responses: [pngResponse, { body: { Key: "public/brand/logo.png", Id: "1" } }] },
  { name: "upload_object: a redirected download", tool: "upload_object", args: UPLOAD, environment: WRITES, responses: [{ status: 302, headers: { location: "/cdn/logo-v2.png" } }, pngResponse, { body: { Key: "public/brand/logo.png" } }] },
  { name: "upload_object: a download without a type", tool: "upload_object", args: UPLOAD, environment: WRITES, responses: [{ bytes: PNG, headers: { "content-type": "" } }, { body: { Key: "k" } }] },
  { name: "upload_object: a failed download", tool: "upload_object", args: UPLOAD, environment: WRITES, responses: [{ status: 404, body: "not found" }], kind: "api_error", message: /Could not download `file`/ },
  { name: "upload_object: an existing object", tool: "upload_object", args: UPLOAD, environment: WRITES, responses: [pngResponse, { status: 400, body: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } }], kind: "invalid_input" },
  { name: "upload_object: a server error says how to check", tool: "upload_object", args: UPLOAD, environment: WRITES, responses: [pngResponse, { status: 502, body: {} }], kind: "api_error", message: /To check: get_object_info for the path/, sameMessage: false },
  { name: "upload_object: never overwrites", tool: "upload_object", args: { ...UPLOAD, upsert: true }, environment: WRITES, kind: "permission_denied", message: /cannot overwrite/ },
  { name: "upload_object: refused without SUPABASE_TOOL_ALLOW_WRITES", tool: "upload_object", args: UPLOAD, kind: "permission_denied" },
  { name: "upload_object: an http file URL", tool: "upload_object", args: { ...UPLOAD, file: "http://files.example.com/a.png" }, environment: WRITES, kind: "invalid_input", message: /https URL/ },
  { name: "upload_object: a loopback file URL", tool: "upload_object", args: { ...UPLOAD, file: "https://127.0.0.1/a.png" }, environment: WRITES, kind: "invalid_input", message: /loopback, private or link-local/ },
  { name: "upload_object: a redirect to http", tool: "upload_object", args: UPLOAD, environment: WRITES, responses: [{ status: 301, headers: { location: "http://files.example.com/a.png" } }], kind: "invalid_input", message: /stay on https \(redirected to/ },
  { name: "upload_object: a local path (no file system in WebAssembly)", tool: "upload_object", args: { ...UPLOAD, file: "/tmp/logo.png" }, environment: WRITES, kind: "invalid_input", sameMessage: false },

  // --- api_request
  { name: "api_request: a read with query values", tool: "api_request", args: { path: "/rest/v1/orders?select=id,total&id=eq.1", query: { id: "eq.2", limit: 5, tags: ["a", "b"], range: { from: 1 }, skip: null } }, responses: [{ body: [{ id: 2 }] }] },
  { name: "api_request: a path with spaces and accents", tool: "api_request", args: { path: "/rest/v1/my table?name=eq.é x" }, responses: [{ body: [] }] },
  { name: "api_request: storage reads", tool: "api_request", args: { path: "/storage/v1/bucket/avatars", method: "get" }, responses: [{ body: { id: "avatars" } }] },
  { name: "api_request: writes are refused", tool: "api_request", args: { path: "/rest/v1/orders", method: "POST", body: { a: 1 } }, kind: "permission_denied", message: /read-only/ },
  { name: "api_request: auth admin is refused", tool: "api_request", args: { path: "/auth/v1/admin/users" }, kind: "permission_denied", message: /\/auth\/v1\/admin\/users/ },
  { name: "api_request: an encoded traversal is refused", tool: "api_request", args: { path: "/rest/v1/%252e%252e/%2e%2e/auth/v1/admin/users" }, kind: "permission_denied" },
  { name: "api_request: SUPABASE_TOOL_API_EXTRA_PATHS", tool: "api_request", args: { path: "/functions/v1/Hello" }, environment: { SUPABASE_TOOL_API_EXTRA_PATHS: "/functions/v1/*" }, responses: [{ body: { ok: true } }] },
  { name: "api_request: a relative path", tool: "api_request", args: { path: "rest/v1/orders" }, kind: "invalid_input", message: /must start with/ },
  { name: "api_request: a body with GET", tool: "api_request", args: { path: "/rest/v1/orders", body: { a: 1 } }, kind: "invalid_input", message: /body/ },
  { name: "api_request: a backslash", tool: "api_request", args: { path: "/rest/v1/a\\b" }, kind: "invalid_input", message: /Unsafe API path/ },
  { name: "api_request: a huge result is not cut", tool: "api_request", args: { path: "/rest/v1/blobs" }, responses: [{ body: { blob: "x".repeat(120000) } }] },
];

const nodeRunner = (environment, fetchImpl) =>
  createOperationRunner(pluginDefinition, environment, { fetchImpl, resolveHostAddresses: async () => [PUBLIC_ADDRESS] });

async function runNode(testCase) {
  const environment = { ...BASE_ENV, ...testCase.environment };
  const fetchImpl = createNodeFetch(testCase);
  const handler = createToolHandler(nodeRunner(environment, fetchImpl), testCase.tool, 120000);
  const outcome = await handler(testCase.args, { secrets: {} }).then(
    (output) => ({ output }),
    (error) => ({ error: { kind: error.kind, message: error.message, retryable: Boolean(error.retryable) } }),
  );
  return { ...outcome, calls: fetchImpl.calls };
}

function createNodeFetch(testCase) {
  const responses = [...(testCase.responses ?? [{ body: [] }])];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(describeCall({ method: init.method ?? "GET", url: String(url), headers: init.headers ?? {}, body: init.body }));
    if (testCase.transport === "refused") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    if (testCase.transport === "timeout") return waitForAbort(init.signal);
    const { status = 200, headers = {}, body = {}, bytes } = responses.shift() ?? {};
    const payload = bytes ?? (status === 204 || status === 302 || status === 301 ? null : typeof body === "string" ? body : JSON.stringify(body));
    return new Response(payload, { status, headers: { "content-type": "application/json", ...headers } });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("the timeout never fired")), 10000);
    signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(signal.reason);
    }, { once: true });
  });
}

function runWasm(testCase) {
  const environment = { ...BASE_ENV, ...testCase.environment };
  const responses = [...(testCase.responses ?? [{ body: [] }])];
  const calls = [];
  const respond = (request) => {
    const body = request.body_base64 === undefined ? request.body : Buffer.from(request.body_base64, "base64");
    calls.push(describeCall({ method: request.method, url: request.url, headers: request.headers ?? {}, body }));
    if (testCase.transport === "timeout") return { error: { kind: "timeout", message: `no complete response within ${request.timeout_ms} ms` } };
    if (testCase.transport === "refused") return { error: { kind: "http_error", message: "error sending request: tcp connect error: Connection refused (os error 61)" } };
    const { status = 200, headers = {}, body: responseBody = {}, bytes } = responses.shift() ?? {};
    const payload = bytes ?? Buffer.from(status === 204 || status === 302 || status === 301 ? "" : typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody));
    const reply = { status, headers: { "content-type": "application/json", ...headers } };
    return request.response_encoding === "base64" ? { ...reply, body_base64: payload.toString("base64") } : { ...reply, body: payload.toString("utf8") };
  };
  const response = wasmPlugin.callTool({ name: testCase.tool, arguments: testCase.args, env: environment }, respond);
  const outcome = response.error
    ? { error: { kind: response.error.kind, message: response.error.message, retryable: Boolean(response.error.retryable) } }
    : { output: { text: response.text, data: response.data } };
  return { ...outcome, calls };
}

// Bodies are compared as base64, so text and binary bodies compare the same way.
function describeCall({ method, url, headers, body }) {
  const lowerCaseHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
  const bodyBytes = body === undefined || body === null ? undefined : Buffer.from(body);
  return { method, url, headers: lowerCaseHeaders, body: bodyBytes?.toString("base64") };
}

const SECRETS = [USER_JWT, PUBLISHABLE_KEY, ANON_KEY];
const assertNoSecret = (value) => {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `a credential leaked: ${text.slice(0, 300)}`);
};

for (const testCase of CASES) {
  test(`node and wasm agree: ${testCase.name}`, async () => {
    const [nodeRun, wasmRun] = [await runNode(testCase), runWasm(testCase)];
    if (testCase.nodeRetries) {
      assert.deepEqual(wasmRun.calls, nodeRun.calls.slice(0, 1), "first HTTP request");
      assert.ok(nodeRun.calls.length > 1, "Node.js retried");
    } else {
      assert.deepEqual(wasmRun.calls, nodeRun.calls, "HTTP requests");
    }
    if (testCase.kind) {
      assert.equal(nodeRun.error?.kind, testCase.kind, `node: ${JSON.stringify(nodeRun).slice(0, 500)}`);
      assert.equal(wasmRun.error?.kind, testCase.kind, `wasm: ${JSON.stringify(wasmRun).slice(0, 500)}`);
      assert.equal(wasmRun.error.retryable, nodeRun.error.retryable, "retryable");
      if (testCase.message) assert.match(wasmRun.error.message, testCase.message);
      if (testCase.sameMessage !== false) assert.equal(wasmRun.error.message, nodeRun.error.message);
    } else {
      assert.equal(nodeRun.error, undefined, JSON.stringify(nodeRun.error));
      assert.equal(wasmRun.error, undefined, JSON.stringify(wasmRun.error));
      assert.deepEqual(wasmRun.output.data, nodeRun.output.data);
      assert.equal(wasmRun.output.text, nodeRun.output.text);
    }
    assertNoSecret({ ...wasmRun, calls: [] });
    assertNoSecret({ ...nodeRun, calls: [] });
  });
}

test("wasm describes the Node.js plugin's tools, without download_object", () => {
  const nodeTools = nodeManifest.tools.filter((tool) => tool.name !== "download_object");
  assert.deepEqual(wasmPlugin.describe().tools, nodeTools);
  assert.deepEqual(wasmManifest.tools, nodeTools, "wasm/supabase/graphrt-plugin.json");
  for (const envName of wasmManifest.permissions.env) assert.ok(nodeManifest.permissions.env.includes(envName), envName);
});

test("wasm has no download_object (a module has no file system)", () => {
  const response = wasmPlugin.callTool({ name: "download_object", arguments: { bucket_id: "a", object_path: "b" }, env: BASE_ENV }, () => assert.fail("no request"));
  assert.equal(response.error.kind, "invalid_input");
  assert.match(response.error.message, /Unknown operation `download_object`/);
});

test("the default module refuses SUPABASE_TOOL_MODE=user_rpc and bad modes", () => {
  const call = (mode) => wasmPlugin.callTool({ name: "select_rows", arguments: { table: "t" }, env: { ...BASE_ENV, SUPABASE_TOOL_MODE: mode } }, () => assert.fail("no request")).error;
  assert.match(call("user_rpc").message, /wasm\/supabase-rpc/);
  assert.throws(() => pluginDefinition.resolveToolOperations({ SUPABASE_TOOL_MODE: "other" }), { message: call("other").message.replace(/^.*?SUPABASE/, "SUPABASE") });
});

test("wasm passes the request deadlines to the host", () => {
  const timeouts = (tool, args, environment = {}) => {
    const seen = [];
    wasmPlugin.callTool({ name: tool, arguments: args, env: { ...BASE_ENV, ...WRITES, ...environment } }, (request) => {
      seen.push(request.timeout_ms);
      return request.response_encoding === "base64" ? { status: 200, headers: {}, body_base64: PNG.toString("base64") } : { status: 200, headers: {}, body: "{}" };
    });
    return seen;
  };
  assert.deepEqual(timeouts("select_rows", { table: "t" }), [30000]);
  assert.deepEqual(timeouts("call_function", { function_name: "f" }, { SUPABASE_TOOL_TIMEOUT_MS: "5000" }), [5000]);
  assert.deepEqual(timeouts("call_function", { function_name: "f" }, { SUPABASE_TOOL_TIMEOUT_MS: "90000" }), [30000]);
  assert.deepEqual(timeouts("upload_object", UPLOAD), [10000, 110000]);
});

test("wasm explains an old host without binary bodies", () => {
  const response = wasmPlugin.callTool({ name: "upload_object", arguments: UPLOAD, env: { ...BASE_ENV, ...WRITES } }, () => ({
    error: { kind: "invalid_request", message: "request JSON: unknown field `response_encoding`, expected one of `method`, `url`, `headers`, `body`, `timeout_ms`" },
  }));
  assert.equal(response.error.kind, "invalid_input");
  assert.match(response.error.message, /graphrt 0\.7\+/);
});
