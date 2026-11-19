import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = "gemini-test-key-0001";
const UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc123&upload_protocol=resumable";
const uploadDirectory = mkdtempSync(join(tmpdir(), "gemini-upload-"));
const localFile = join(uploadDirectory, "notes.txt");
writeFileSync(localFile, "hello gemini");
after(() => rmSync(uploadDirectory, { recursive: true, force: true }));

// A fetch double that answers the start request with an upload URL header and the finalize request with the file.
function createUploadFetch({ startHeaders = { "x-goog-upload-url": UPLOAD_URL }, finalizeResponse } = {}) {
  const calls = [];
  const uploadFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body });
    if (String(url).startsWith("https://files.example.org/")) return new Response("remote file body", { headers: { "content-type": "text/plain" } });
    if (calls.filter((call) => call.url.includes("generativelanguage")).length === 1) {
      return new Response("{}", { headers: { "content-type": "application/json", ...startHeaders } });
    }
    return finalizeResponse?.() ?? new Response(JSON.stringify({ file: { name: "files/abc", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", state: "ACTIVE" } }), { headers: { "content-type": "application/json" } });
  };
  uploadFetch.calls = calls;
  return uploadFetch;
}

function runUpload(args, uploadFetch, { source = "node", environment = {} } = {}) {
  const run = createOperationRunner(pluginDefinition, { GEMINI_API_KEY: API_KEY, GEMINI_UPLOAD_DIR: uploadDirectory, ...environment }, { fetchImpl: uploadFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  return run("upload_file", args, { source }).then((output) => ({ output }), (error) => ({ error }));
}

test("upload_file starts a resumable upload, then uploads and finalizes the bytes", async () => {
  const uploadFetch = createUploadFetch();
  const { output, error } = await runUpload({ file: localFile, display_name: "Notes" }, uploadFetch);
  if (error) throw error;
  const [start, finalize] = uploadFetch.calls;
  assert.equal(start.url, "https://generativelanguage.googleapis.com/upload/v1beta/files");
  assert.equal(start.method, "POST");
  assert.equal(start.headers["x-goog-api-key"], API_KEY);
  assert.equal(start.headers["x-goog-upload-protocol"], "resumable");
  assert.equal(start.headers["x-goog-upload-command"], "start");
  assert.equal(start.headers["x-goog-upload-header-content-length"], "12");
  assert.equal(start.headers["x-goog-upload-header-content-type"], "text/plain");
  assert.deepEqual(JSON.parse(start.body), { file: { display_name: "Notes" } });
  assert.equal(finalize.url, UPLOAD_URL);
  assert.equal(finalize.headers["x-goog-upload-command"], "upload, finalize");
  assert.equal(finalize.headers["x-goog-upload-offset"], "0");
  assert.equal(Buffer.from(finalize.body).toString(), "hello gemini");
  assert.deepEqual(output.data, { name: "files/abc", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc", state: "ACTIVE" });
});

test("upload_file downloads an https URL with the public-https checks and keeps mime_type overrides", async () => {
  const uploadFetch = createUploadFetch();
  const { error } = await runUpload({ file: "https://files.example.org/a.txt", mime_type: "text/markdown" }, uploadFetch);
  if (error) throw error;
  const start = uploadFetch.calls.find((call) => call.url.endsWith("/upload/v1beta/files"));
  assert.equal(start.headers["x-goog-upload-header-content-type"], "text/markdown");
  assert.equal(start.headers["x-goog-api-key"], API_KEY);
  assert.equal(uploadFetch.calls[0].headers["x-goog-api-key"], undefined, "the key never goes to the file host");
  assert.deepEqual(JSON.parse(start.body), { file: { display_name: "a.txt" } });
});

test("upload_file refuses local paths outside GEMINI_UPLOAD_DIR and without it", async () => {
  const outside = await runUpload({ file: "/etc/hosts" }, createUploadFetch());
  assert.equal(outside.error?.kind, "invalid_input");
  const disabled = await runUpload({ file: localFile }, createUploadFetch(), { environment: { GEMINI_UPLOAD_DIR: "" } });
  assert.equal(disabled.error?.kind, "invalid_input");
});

test("an upload URL on another host is refused before any bytes are sent", async () => {
  const uploadFetch = createUploadFetch({ startHeaders: { "x-goog-upload-url": "https://evil.example.com/upload?upload_id=1" } });
  const { error } = await runUpload({ file: localFile }, uploadFetch);
  assert.equal(error?.kind, "api_error");
  assert.equal(uploadFetch.calls.length, 1);
});

test("a missing upload URL is an api_error", async () => {
  const { error } = await runUpload({ file: localFile }, createUploadFetch({ startHeaders: {} }));
  assert.equal(error?.kind, "api_error");
  assert.match(error.message, /x-goog-upload-url/);
});

test("a failed finalize is not retried and says how to check", async () => {
  const uploadFetch = createUploadFetch({ finalizeResponse: () => new Response(JSON.stringify({ error: { message: "backend error" } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "0" } }) });
  const { error } = await runUpload({ file: localFile }, uploadFetch);
  assert.equal(uploadFetch.calls.length, 2, "one start, one finalize");
  assert.equal(error.retryable, false);
  assert.match(error.message, /outcome unknown/);
  assert.match(error.message, /list_files/);
  assert.equal(error.message.includes(API_KEY), false);
});

test("an invalid API key on start is an auth_error", async () => {
  const uploadFetch = async () => new Response(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400, headers: { "content-type": "application/json" } });
  const { error } = await runUpload({ file: localFile }, uploadFetch);
  assert.equal(error?.kind, "auth_error");
});

test("upload_file is an agent tool that requires file", async () => {
  assert.ok(buildManifest(pluginDefinition).tools.some((tool) => tool.name === "upload_file"));
  const { error } = await runUpload({}, createUploadFetch());
  assert.equal(error?.kind, "invalid_input");
});
