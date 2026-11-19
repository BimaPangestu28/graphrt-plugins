import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { createErrorParser, createBodyErrorDetector } from "../lib/shared/rest-errors.mjs";
import { pluginDefinition, resolveRegionalBaseUrl } from "../definition.mjs";

const API_KEY = { ZEROBOUNCE_API_KEY: "fake-key" };

async function runZeroBounce(operationName, args, { environment = API_KEY, source = "tool", responses = [{ body: { address: "ada@example.com", status: "valid" } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("manifest: bulk files are node only, batch is opt-in, api_key never a tool parameter", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["send_file", "get_file_status", "get_file", "delete_file"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  for (const operation of pluginDefinition.operations) assert.equal(Object.hasOwn(operation.parameters.properties, "api_key"), false, operation.name);
  assert.deepEqual(manifest.permissions.env.sort(), ["ZEROBOUNCE_API_KEY", "ZEROBOUNCE_FILE_DIR", "ZEROBOUNCE_OUTPUT_DIR", "ZEROBOUNCE_REGION", "ZEROBOUNCE_TOOL_ALLOW_BATCH"]);
});

test("ZEROBOUNCE_REGION picks the default, US or EU host and refuses anything else", () => {
  assert.equal(resolveRegionalBaseUrl({}), "https://api.zerobounce.net/v2");
  assert.equal(resolveRegionalBaseUrl({ ZEROBOUNCE_REGION: "US" }), "https://api-us.zerobounce.net/v2");
  assert.equal(resolveRegionalBaseUrl({ ZEROBOUNCE_REGION: "eu" }), "https://api-eu.zerobounce.net/v2");
  assert.throws(() => resolveRegionalBaseUrl({ ZEROBOUNCE_REGION: "evil.example" }), /default, us or eu/);
});

test("validate_email goes to the regional host; the key in the query is redacted from errors", async () => {
  const { calls } = await runZeroBounce("validate_email", { email: "ada@example.com" }, { environment: { ...API_KEY, ZEROBOUNCE_REGION: "eu" } });
  assert.equal(calls[0].path, "/v2/validate");
  assert.equal(new URL(calls[0].url).host, "api-eu.zerobounce.net");
  assert.equal(calls[0].query.api_key, "fake-key");
  const failed = await runZeroBounce("validate_email", { email: "ada@example.com" }, { responses: [{ status: 400, body: { error: "bad request for api_key=fake-key" } }] });
  assert.equal(failed.error.message.includes("fake-key"), false);
});

test("validate_email spends credits: never retried after a 5xx, error says how to check", async () => {
  const { error, calls } = await runZeroBounce("validate_email", { email: "ada@example.com" }, { responses: [{ status: 503, body: {} }, { body: {} }] });
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /get_credits/);
});

test("validate_batch: the key goes in the JSON body from the credential, a caller's api_key is ignored", async () => {
  const environment = { ...API_KEY, ZEROBOUNCE_TOOL_ALLOW_BATCH: "1" };
  const { error, calls } = await runZeroBounce("validate_batch", { email_batch: [{ email_address: "ada@example.com" }], api_key: "attacker-key" }, { environment, responses: [{ body: { email_batch: [], errors: [] } }] });
  if (error) throw error;
  assert.equal(calls[0].json.api_key, "fake-key");
});

test("validate_batch as a tool needs the opt-in and at most 100 addresses", async () => {
  const refused = await runZeroBounce("validate_batch", { email_batch: [{ email_address: "ada@example.com" }] });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.match(refused.error.message, /ZEROBOUNCE_TOOL_ALLOW_BATCH/);
  const tooMany = await runZeroBounce("validate_batch", { email_batch: Array.from({ length: 101 }, (_, index) => ({ email_address: `u${index}@example.com` })) }, { source: "node" });
  assert.equal(tooMany.error?.kind, "invalid_input");
  assert.equal(tooMany.calls.length, 0);
});

test("an invalid-key error body (200 or 400) is an auth_error on every operation", async () => {
  for (const status of [200, 400]) {
    const { error } = await runZeroBounce("validate_email", { email: "ada@example.com" }, { responses: [{ status, body: { error: "Invalid API key or your account ran out of credits" } }] });
    assert.equal(error?.kind, "auth_error", String(status));
  }
  const usage = await runZeroBounce("get_api_usage", { start_date: "2026-01-01", end_date: "2026-01-02" }, { responses: [{ body: { error: "Invalid API Key" } }] });
  assert.equal(usage.error?.kind, "auth_error");
});

test("get_credits: -1 (ZeroBounce's answer to an invalid key) is an auth_error", async () => {
  const invalid = await runZeroBounce("get_credits", {}, { responses: [{ body: { Credits: "-1" } }] });
  assert.equal(invalid.error?.kind, "auth_error");
  const valid = await runZeroBounce("get_credits", {}, { responses: [{ body: { Credits: "2375" } }] });
  assert.equal(valid.output.data, "2375");
});

test("200 error bodies map: {error} on real-time calls, {success: false} on bulk calls", () => {
  const detectBodyError = createBodyErrorDetector(pluginDefinition.restSpec.errors);
  assert.equal(detectBodyError({ error: "Invalid API key or your account ran out of credits" }).message, "Invalid API key or your account ran out of credits");
  assert.equal(detectBodyError({ success: false, message: "File cannot be found." }).message, "File cannot be found.");
  assert.equal(detectBodyError({ success: true, file_id: "f1" }), null);
  assert.equal(detectBodyError({ address: "ada@example.com", status: "valid" }), null);
  assert.equal(createErrorParser(pluginDefinition.restSpec.errors)(400, { success: false, message: "Duplicates over 50%" }).message, "Duplicates over 50%");
});

test("api_request as a tool only reads /getcredits and /getapiusage (no billed /validate, no bypasses)", async () => {
  for (const path of ["/validate?email=a@b.c", "/getcredits/%2e%2e/validate", "/getcredits/%252e%252e/validate", "/activity?email=a@b.c"]) {
    const refused = await runZeroBounce("api_request", { path });
    assert.equal(refused.error?.kind, "permission_denied", path);
    assert.equal(refused.calls.length, 0, path);
  }
  const allowed = await runZeroBounce("api_request", { path: "/getapiusage?start_date=2026-01-01&end_date=2026-01-31" }, { responses: [{ body: { total: 3 } }] });
  if (allowed.error) throw allowed.error;
});

test("get_file saves the CSV into ZEROBOUNCE_OUTPUT_DIR and refuses a JSON error body (no file kept)", async () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "zb-out-"));
  const environment = { ...API_KEY, ZEROBOUNCE_OUTPUT_DIR: outputDirectory };
  const saved = await runZeroBounce("get_file", { file_id: "f1" }, { environment, source: "node", responses: [{ body: "email,status\nada@example.com,valid\n", headers: { "content-type": "application/octet-stream" } }] });
  if (saved.error) throw saved.error;
  assert.equal(saved.calls[0].url.startsWith("https://bulkapi.zerobounce.net/v2/getfile?"), true);
  assert.equal(readdirSync(outputDirectory).length, 1);
  assert.match(saved.output.data.path, /\.csv$/, "result files are CSV whatever the content type");
  assert.match(readdirSync(outputDirectory)[0], /^get_file-.*\.csv$/);
  const failed = await runZeroBounce("get_file", { file_id: "nope" }, { environment, source: "node", responses: [{ body: { success: false, message: "File cannot be found." } }] });
  assert.equal(failed.error?.kind, "api_error");
  assert.match(failed.error.message, /File cannot be found/);
  assert.equal(readdirSync(outputDirectory).length, 1, "the error file is removed");
});

test("send_file refuses local files outside ZEROBOUNCE_FILE_DIR and sends the key as a form field", async () => {
  const uploadDirectory = mkdtempSync(join(tmpdir(), "zb-in-"));
  const csvPath = join(uploadDirectory, "list.csv");
  writeFileSync(csvPath, "email\nada@example.com\n");
  const refused = await runZeroBounce("send_file", { file: csvPath, email_address_column: 1 }, { source: "node" });
  assert.equal(refused.error?.kind, "invalid_input");
  assert.match(refused.error.message, /ZEROBOUNCE_FILE_DIR/);
  assert.equal(refused.calls.length, 0);
  const sent = await runZeroBounce("send_file", { file: csvPath, email_address_column: 1, has_header_row: true }, { environment: { ...API_KEY, ZEROBOUNCE_FILE_DIR: uploadDirectory }, source: "node", responses: [{ body: { success: true, file_id: "f1" } }] });
  if (sent.error) throw sent.error;
  assert.equal(sent.calls[0].formData.get("api_key"), "fake-key");
  assert.equal(sent.calls[0].formData.get("email_address_column"), "1");
});
