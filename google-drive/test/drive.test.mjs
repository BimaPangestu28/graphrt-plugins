import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { buildDriveQuery, quoteDriveValue } from "../lib/drive-query.mjs";
import { buildMultipartRelatedBody } from "../lib/upload-file.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN = "ya29.drive-token-1";

async function runDrive(operationName, args, { responses = [{ body: { id: "new1" } }], environment = {}, source = "tool" } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  // createRecordingFetch keeps string bodies only; keep the raw (Buffer) body of each call too.
  const capturingFetch = async (url, init) => {
    const response = await recordingFetch(url, init);
    recordingFetch.calls.at(-1).rawBody = init?.body;
    return response;
  };
  const run = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: TOKEN, ...environment }, { fetchImpl: capturingFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

function withUploadDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "drive-upload-"));
  writeFileSync(join(directory, "notes.txt"), "hello drive");
  return callback(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test("search_files escapes values so they cannot change the query", () => {
  assert.equal(quoteDriveValue("a\\b'c"), "'a\\\\b\\'c'");
  assert.equal(buildDriveQuery({ name_contains: "x' or name contains '" }), "name contains 'x\\' or name contains \\'' and trashed = false");
  assert.equal(buildDriveQuery({ full_text: "budget", modified_after: "2026-11-01T00:00:00Z", include_trashed: true }), "fullText contains 'budget' and modifiedTime > '2026-11-01T00:00:00Z'");
  assert.throws(() => buildDriveQuery({ folder_id: "x' in parents or '1" }), (error) => error.kind === "invalid_input");
  assert.throws(() => buildDriveQuery({ modified_after: "yesterday" }), (error) => error.kind === "invalid_input");
});

test("search_files modified_after needs an RFC 3339 date-time with seconds", () => {
  for (const partial of ["2026-11-01", "2026-11-01T10:00", "2026-11-01 10:00:00"]) {
    assert.throws(() => buildDriveQuery({ modified_after: partial }), (error) => error.kind === "invalid_input", partial);
  }
  assert.equal(buildDriveQuery({ modified_after: "2026-11-01T10:00:00.5+07:00", include_trashed: true }), "modifiedTime > '2026-11-01T10:00:00.5+07:00'");
});

test("search_files offers plain fields instead of q", () => {
  const searchTool = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "search_files");
  assert.equal("q" in searchTool.parameters.properties, false);
  assert.ok(searchTool.parameters.properties.name_contains);
});

test("upload_file sends multipart/related metadata + media to the upload endpoint", () =>
  withUploadDirectory(async (directory) => {
    const { output, error, calls } = await runDrive("upload_file", { file: join(directory, "notes.txt"), folder_id: "f1", convert_to: "application/vnd.google-apps.document" }, { environment: { GOOGLE_DRIVE_UPLOAD_DIR: directory, GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST: "f1" } });
    if (error) throw error;
    const call = calls[0];
    const callUrl = new URL(call.url);
    assert.equal(`${callUrl.origin}${callUrl.pathname}`, "https://www.googleapis.com/upload/drive/v3/files");
    assert.deepEqual(call.query, { uploadType: "multipart", supportsAllDrives: "true", fields: "id,name,mimeType,size,parents,webViewLink" });
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    const boundary = /^multipart\/related; boundary=(graphrt-[0-9a-f]{32})$/.exec(call.headers["content-type"])[1];
    const sentBody = Buffer.from(call.rawBody).toString();
    assert.equal(
      sentBody,
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"notes.txt","parents":["f1"],"mimeType":"application/vnd.google-apps.document"}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\nhello drive\r\n--${boundary}--`,
    );
    assert.deepEqual(output.data, { id: "new1" });
  }));

test("upload_file is not retried after a 5xx and says how to check", () =>
  withUploadDirectory(async (directory) => {
    const { error, calls } = await runDrive("upload_file", { file: join(directory, "notes.txt") }, { environment: { GOOGLE_DRIVE_UPLOAD_DIR: directory }, responses: [{ status: 503, headers: { "retry-after": "0" }, body: { error: { code: 503, message: "Backend Error" } } }, { body: { id: "x" } }] });
    assert.equal(calls.length, 1);
    assert.equal(error.retryable, false);
    assert.match(error.message, /outcome unknown.*search_files/);
  }));

test("upload_file refuses local paths without GOOGLE_DRIVE_UPLOAD_DIR and files over 5 MB", () =>
  withUploadDirectory(async (directory) => {
    const noDirectory = await runDrive("upload_file", { file: join(directory, "notes.txt") });
    assert.equal(noDirectory.error.kind, "invalid_input");
    writeFileSync(join(directory, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    const tooBig = await runDrive("upload_file", { file: join(directory, "big.bin") }, { environment: { GOOGLE_DRIVE_UPLOAD_DIR: directory } });
    assert.equal(tooBig.error.kind, "invalid_input");
    assert.equal(tooBig.calls.length, 0);
  }));

test("multipart/related bodies refuse content types with line breaks", () => {
  assert.throws(() => buildMultipartRelatedBody({ name: "x" }, Buffer.from("x"), "text/plain\r\nX-Evil: 1"), (error) => error.kind === "invalid_input");
});

test("sharing, trashing and deleting are not agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const nodeOnlyName of ["share_file", "remove_permission", "trash_file", "delete_file"]) assert.equal(toolNames.includes(nodeOnlyName), false, nodeOnlyName);
  assert.ok(toolNames.includes("upload_file"));
  assert.equal(toolNames.at(-1), "api_request");
});

test("Drive's 403 rate-limit reason maps to rate_limited and is retried", async () => {
  const rateLimited = { status: 403, body: { error: { code: 403, message: "User Rate Limit Exceeded", errors: [{ reason: "userRateLimitExceeded" }] } } };
  const { output, calls } = await runDrive("get_file", { file_id: "a" }, { responses: [{ ...rateLimited, headers: { "retry-after": "0" } }, { body: { id: "a" } }] });
  assert.equal(calls.length, 2);
  assert.deepEqual(output.data, { id: "a" });
});
