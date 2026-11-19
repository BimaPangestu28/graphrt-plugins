import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const RETURN_ROWS = "return=representation,missing=default";

describeRestPluginContract(pluginDefinition, {
  // The generated suite calls api_request on "/anything" as a tool (the extra-paths env lets it through) and the
  // upload redaction test runs as a tool (the opt-in refusal tests set SUPABASE_TOOL_ALLOW_WRITES="" themselves).
  environment: { SUPABASE_URL: PROJECT, SUPABASE_TOOL_ALLOW_WRITES: "1", SUPABASE_TOOL_API_EXTRA_PATHS: "/anything" },
  checkAuth: (call, credential) => {
    assert.equal(call.headers.apikey, credential);
    assert.equal(call.headers.authorization, undefined, "a non-JWT key is never sent as Bearer");
  },
  operations: {
    get_api_schema: {
      args: {},
      request: { method: "GET", url: `${PROJECT}/rest/v1/`, query: "absent" },
    },
    select_rows: {
      args: { table: "todos", columns: "id,title", filters: [{ column: "status", operator: "eq", value: "open,done" }, { column: "due", operator: "lt", value: "2026-12-01" }], order: "due.asc", limit: 10, db_schema: "app" },
      request: {
        method: "GET",
        url: `${PROJECT}/rest/v1/todos`,
        query: { select: "id,title", and: '(status.eq."open,done",due.lt."2026-12-01")', order: "due.asc", limit: "10" },
        headers: { "Accept-Profile": "app" },
      },
      response: { body: [{ id: 1, title: "Ship" }] },
      expect: { data: [{ id: 1, title: "Ship" }] },
    },
    insert_rows: {
      args: { table: "todos", rows: [{ title: "Ship" }] },
      request: { method: "POST", url: `${PROJECT}/rest/v1/todos`, query: "absent", json: [{ title: "Ship" }], headers: { Prefer: RETURN_ROWS } },
    },
    upsert_rows: {
      args: { table: "profiles", rows: [{ email: "a@example.com", name: "A" }], on_conflict: "email", duplicates: "ignore" },
      request: {
        method: "POST",
        url: `${PROJECT}/rest/v1/profiles`,
        query: { on_conflict: "email" },
        json: [{ email: "a@example.com", name: "A" }],
        headers: { Prefer: `resolution=ignore-duplicates,${RETURN_ROWS}` },
      },
    },
    update_rows: {
      args: { table: "todos", values: { status: "done" }, filters: [{ column: "id", operator: "eq", value: 7 }] },
      request: { method: "PATCH", url: `${PROJECT}/rest/v1/todos`, query: { and: '(id.eq."7")' }, json: { status: "done" }, headers: { Prefer: RETURN_ROWS } },
    },
    delete_rows: {
      args: { table: "todos", filters: [{ column: "id", operator: "in", value: [1, 2] }] },
      request: { method: "DELETE", url: `${PROJECT}/rest/v1/todos`, query: { and: '(id.in.("1","2"))' }, body: "absent", headers: { Prefer: RETURN_ROWS } },
    },
    call_function: {
      args: { function_name: "close_overdue", arguments: { days: 3 } },
      request: { method: "POST", url: `${PROJECT}/rest/v1/rpc/close_overdue`, query: "absent", json: { days: 3 } },
    },
    list_buckets: {
      args: {},
      request: { method: "GET", url: `${PROJECT}/storage/v1/bucket`, query: "absent" },
    },
    get_bucket: {
      args: { bucket_id: "avatars" },
      request: { method: "GET", url: `${PROJECT}/storage/v1/bucket/avatars`, query: "absent" },
    },
    list_objects: {
      args: { bucket_id: "docs", prefix: "invoices/2026", sort_column: "created_at", sort_order: "desc", limit: 50 },
      request: {
        method: "POST",
        url: `${PROJECT}/storage/v1/object/list/docs`,
        query: "absent",
        json: { prefix: "invoices/2026", sortBy: { column: "created_at", order: "desc" }, limit: 50 },
      },
      response: { body: [{ name: "11.pdf" }] },
      expect: { data: [{ name: "11.pdf" }] },
    },
    get_object_info: {
      args: { bucket_id: "docs", object_path: "invoices/2026/11 final.pdf" },
      request: { method: "GET", url: `${PROJECT}/storage/v1/object/info/authenticated/docs/invoices/2026/11%20final.pdf`, query: "absent" },
    },
    download_object: {
      args: { bucket_id: "docs", object_path: "invoices/11.pdf" },
      request: { method: "GET", url: `${PROJECT}/storage/v1/object/authenticated/docs/invoices/11.pdf`, query: "absent" },
    },
    upload_object: {
      args: { bucket_id: "docs", object_path: "reports/r.pdf", file: "https://files.contract.example/r.pdf", cache_control: "max-age=60" },
      request: { method: "POST", url: `${PROJECT}/storage/v1/object/docs/reports/r.pdf`, query: "absent", file: true, headers: { "x-upsert": "false", "cache-control": "max-age=60" } },
    },
    delete_objects: {
      args: { bucket_id: "docs", paths: ["a.pdf", "b/c.pdf"] },
      request: { method: "DELETE", url: `${PROJECT}/storage/v1/object/docs`, query: "absent", json: { prefixes: ["a.pdf", "b/c.pdf"] } },
    },
    create_signed_url: {
      args: { bucket_id: "docs", object_path: "a.pdf", expires_in: 600 },
      request: { method: "POST", url: `${PROJECT}/storage/v1/object/sign/docs/a.pdf`, query: "absent", json: { expiresIn: 600 } },
    },
  },
});
