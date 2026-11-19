import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { resolveChromaDatabaseUrl } from "../lib/chroma-config.mjs";
import { pluginDefinition } from "../definition.mjs";

const LOCAL_DB = "http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database";

async function run(operationName, args, { environment = {}, source = "tool", responses = [{ body: {} }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

test("defaults to a local server with the default tenant and database", () => {
  assert.equal(resolveChromaDatabaseUrl({}), LOCAL_DB);
  assert.equal(resolveChromaDatabaseUrl({ CHROMA_URL: "https://api.trychroma.com/", CHROMA_TENANT: "t/1", CHROMA_DATABASE: "db" }), "https://api.trychroma.com/api/v2/tenants/t%2F1/databases/db");
  assert.throws(() => resolveChromaDatabaseUrl({ CHROMA_DATABASE: ".." }), /CHROMA_DATABASE/);
});

test("a local server works without a token: no auth header is sent", async () => {
  const { calls } = await run("list_collections", {}, { responses: [{ body: [] }] });
  assert.equal(calls[0].url, `${LOCAL_DB}/collections`);
  assert.equal(calls[0].headers["x-chroma-token"], undefined);
  assert.equal(calls[0].headers.authorization, undefined);
});

test("the token goes in x-chroma-token, or as a Bearer token with CHROMA_AUTH_HEADER=authorization", async () => {
  const tokenCall = await run("heartbeat", {}, { environment: { CHROMA_API_KEY: "ck-secret" } });
  assert.equal(tokenCall.calls[0].headers["x-chroma-token"], "ck-secret");
  const bearerCall = await run("heartbeat", {}, { environment: { CHROMA_API_KEY: "ck-secret", CHROMA_AUTH_HEADER: "Authorization" } });
  assert.equal(bearerCall.calls[0].headers.authorization, "Bearer ck-secret");
  await assert.rejects(run("heartbeat", {}, { environment: { CHROMA_API_KEY: "ck-secret", CHROMA_AUTH_HEADER: "x-api-key" } }), (error) => error.kind === "invalid_input");
});

test("Chroma's {error, message} body maps to a not_found error with the message, the token redacted", async () => {
  const environment = { CHROMA_API_KEY: "ck-secret" };
  await assert.rejects(
    run("get_collection", { collection_name: "missing" }, { environment, responses: [{ status: 404, body: { error: "NotFoundError", message: "Collection [missing] does not exist ck-secret" } }] }),
    (error) => error.kind === "not_found" && error.message.includes("does not exist") && !error.message.includes("ck-secret"),
  );
});

test("plain http to a remote server is refused", async () => {
  await assert.rejects(run("heartbeat", {}, { environment: { CHROMA_URL: "http://chroma.example.com:8000" }, responses: [] }), (error) => error.kind === "invalid_input");
});

test("tool writes need CHROMA_TOOL_ALLOW_WRITES=1; deletes are not tools", async () => {
  const args = { collection_id: "c1", ids: ["a"], embeddings: [[0.1]] };
  await assert.rejects(run("upsert_records", args), (error) => error.kind === "permission_denied" && error.message.includes("CHROMA_TOOL_ALLOW_WRITES"));
  const allowed = await run("upsert_records", args, { environment: { CHROMA_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(allowed.calls.length, 1);
  for (const name of ["delete_records", "delete_collection"]) {
    await assert.rejects(run(name, { collection_id: "c1", collection_name: "x" }, { environment: { CHROMA_TOOL_ALLOW_WRITES: "1" } }), (error) => error.message.includes("Unknown operation"), name);
  }
});

test("tool api_request stays on collection metadata of the configured database", async () => {
  for (const path of ["/collections/c1/../../../../other_db/collections", "/../../../reset", "/collections/c1/fork_count", "/collections/c1/functions/f"]) {
    await assert.rejects(run("api_request", { path }), (error) => error.kind === "permission_denied", path);
  }
  const { calls } = await run("api_request", { path: "/collections/c1/indexing_status" });
  assert.equal(calls[0].url, `${LOCAL_DB}/collections/c1/indexing_status`);
});
