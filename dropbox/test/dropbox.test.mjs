import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { encodeDropboxApiArg } from "../lib/dropbox-api-arg.mjs";
import { assertToolPathsAllowed, normalizeDropboxPath, PATH_ALLOWLIST_ENV } from "../lib/path-policy.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN = "sl.dropbox-test-token-0001";
const MOVE_OPT_IN = "DROPBOX_TOOL_ALLOW_MOVE";

async function runDropbox(operationName, args, { environment = {}, source = "tool", responses = [{ body: { metadata: { id: "id:1" } } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { DROPBOX_ACCESS_TOKEN_UNUSED: "", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, { ...args, ...(source === "node" ? { access_token: TOKEN } : {}) }, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

// Tools cannot pass access_token, so tool runs use the OAuth envs with a canned token response first.
const OAUTH_ENV = { DROPBOX_APP_KEY: "app-key", DROPBOX_APP_SECRET: "app-secret-0001", DROPBOX_REFRESH_TOKEN: "refresh-0001" };
const TOKEN_RESPONSE = { body: { access_token: TOKEN, expires_in: 14400 } };

test("encodeDropboxApiArg escapes every non-ASCII character and DEL as \\uXXXX", () => {
  const encoded = encodeDropboxApiArg({ path: "/Café/日本\u007f😀.txt" });
  assert.equal(encoded, '{"path":"/Caf\\u00e9/\\u65e5\\u672c\\u007f\\ud83d\\ude00.txt"}');
  assert.ok(/^[\x20-\x7e]*$/.test(encoded));
  assert.deepEqual(JSON.parse(encoded), { path: "/Café/日本\u007f😀.txt" });
});

test("download_file sends its path in the Dropbox-API-Arg header, with no body and no Content-Type", async () => {
  const downloadDirectory = mkdtempSync(join(tmpdir(), "dropbox-download-"));
  const { output, error, calls } = await runDropbox("download_file", { path: "/Ré/a.txt" }, { source: "node", environment: { DROPBOX_DOWNLOAD_DIR: downloadDirectory }, responses: [{ body: "hello", headers: { "content-type": "application/octet-stream" } }] });
  if (error) throw error;
  assert.equal(calls[0].url, "https://content.dropboxapi.com/2/files/download");
  assert.equal(calls[0].headers["dropbox-api-arg"], '{"path":"/R\\u00e9/a.txt"}');
  assert.equal(calls[0].headers["content-type"], undefined);
  assert.equal(calls[0].body, undefined);
  assert.equal(output.data.bytes, 5);
});

test("upload_file folds mode/autorename/mute/strict_conflict into the header and sends the file as octet-stream", async () => {
  const uploadDirectory = mkdtempSync(join(tmpdir(), "dropbox-upload-"));
  const localFile = join(uploadDirectory, "report.pdf");
  writeFileSync(localFile, "PDF-BYTES");
  const { error, calls } = await runDropbox("upload_file", { file: localFile, path: "/Reports/report.pdf", mode: "overwrite", autorename: true, mute: true }, { source: "node", environment: { DROPBOX_UPLOAD_DIR: uploadDirectory }, responses: [{ body: { id: "id:9" } }] });
  if (error) throw error;
  const uploadCall = calls[0];
  assert.equal(uploadCall.url, "https://content.dropboxapi.com/2/files/upload");
  assert.deepEqual(JSON.parse(uploadCall.headers["dropbox-api-arg"]), { path: "/Reports/report.pdf", mode: "overwrite", autorename: true, mute: true });
  assert.equal(uploadCall.headers["content-type"], "application/octet-stream");
  assert.equal(new URL(uploadCall.url).search, "");
});

test("normalizeDropboxPath lowercases, collapses slashes and refuses dot segments and id:/ns:/rev: forms", () => {
  assert.equal(normalizeDropboxPath("/Team//Shared/"), "/team/shared");
  assert.equal(normalizeDropboxPath("/"), "/");
  for (const refusedPath of ["/a/../b", "/a/./b", "id:abc", "ns:123/x", "rev:abc", "relative/path", ""]) {
    assert.equal(normalizeDropboxPath(refusedPath), null, refusedPath);
  }
});

test("assertToolPathsAllowed: unset refuses tools, prefixes match whole segments, * allows any, nodes are free", () => {
  const toolContext = (allowlist) => ({ source: "tool", environment: allowlist === undefined ? {} : { [PATH_ALLOWLIST_ENV]: allowlist } });
  assert.throws(() => assertToolPathsAllowed(toolContext(undefined), ["/Agent/a.txt"]), (error) => error.kind === "permission_denied" && error.message.includes(PATH_ALLOWLIST_ENV));
  assert.doesNotThrow(() => assertToolPathsAllowed(toolContext("/Agent, /Inbox/"), ["/agent/sub/a.txt"]));
  assert.doesNotThrow(() => assertToolPathsAllowed(toolContext("/Agent"), ["/AGENT"]));
  assert.throws(() => assertToolPathsAllowed(toolContext("/Agent"), ["/Agent-shared/a.txt"]), (error) => error.kind === "permission_denied");
  assert.throws(() => assertToolPathsAllowed(toolContext("/Agent"), ["/Agent/../Shared/a.txt"]), (error) => error.kind === "permission_denied");
  assert.throws(() => assertToolPathsAllowed(toolContext("/Agent"), ["id:abc"]), (error) => error.kind === "permission_denied");
  assert.doesNotThrow(() => assertToolPathsAllowed(toolContext("*"), ["/anything/x"]));
  assert.doesNotThrow(() => assertToolPathsAllowed({ source: "node", environment: {} }, ["/anything/x"]));
});

test("upload_file as a tool needs the destination inside DROPBOX_TOOL_PATH_ALLOWLIST; nothing is read or sent otherwise", async () => {
  const refused = await runDropbox("upload_file", { file: "https://files.example/a.txt", path: "/Shared/a.txt" }, { environment: { ...OAUTH_ENV, [PATH_ALLOWLIST_ENV]: "/Agent" } });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
});

test("move and copy as tools need DROPBOX_TOOL_ALLOW_MOVE=1 and an allowed destination", async () => {
  for (const operationName of ["move", "copy"]) {
    const args = { from_path: "/Agent/a.txt", to_path: "/Shared/a.txt" };
    const withoutOptIn = await runDropbox(operationName, args, { environment: { ...OAUTH_ENV, [PATH_ALLOWLIST_ENV]: "*" } });
    assert.equal(withoutOptIn.error?.kind, "permission_denied", operationName);
    assert.match(withoutOptIn.error.message, new RegExp(MOVE_OPT_IN));
    const outsideAllowlist = await runDropbox(operationName, args, { environment: { ...OAUTH_ENV, [MOVE_OPT_IN]: "1", [PATH_ALLOWLIST_ENV]: "/Agent" } });
    assert.equal(outsideAllowlist.error?.kind, "permission_denied", operationName);
    assert.equal(outsideAllowlist.calls.length, 0);
    const allowed = await runDropbox(operationName, { from_path: "/Agent/a.txt", to_path: "/Agent/b.txt" }, { environment: { ...OAUTH_ENV, [MOVE_OPT_IN]: "1", [PATH_ALLOWLIST_ENV]: "/Agent" }, responses: [TOKEN_RESPONSE, { body: { metadata: { id: "id:1" } } }] });
    if (allowed.error) throw allowed.error;
    assert.equal(allowed.calls.at(-1).url, `https://api.dropboxapi.com/2/files/${operationName}_v2`);
  }
});

test("delete, shared links and temporary links are not agent tools", async () => {
  for (const operationName of ["delete", "create_shared_link", "list_shared_links", "get_temporary_link"]) {
    const operation = pluginDefinition.operations.find((candidate) => candidate.name === operationName);
    assert.equal(operation?.nodeOnly, true, operationName);
  }
});

test("a 409 path error keeps Dropbox's error_summary in the message", async () => {
  const { error } = await runDropbox("get_metadata", { path: "/missing" }, { source: "node", responses: [{ status: 409, body: { error_summary: "path/not_found/..", error: { ".tag": "path", path: { ".tag": "not_found" } } } }] });
  assert.match(error.message, /path\/not_found/);
});
