import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const FOLDER_ALLOWLIST_ENV = "GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST";
const parentSettingCalls = [
  ["copy_file", { file_id: "a", parent_ids: ["attacker"] }],
  ["update_file", { file_id: "a", add_parents: "attacker" }],
  ["create_folder", { name: "x", parent_ids: ["attacker"] }],
];

async function runDrive(operationName, args, { environment = {}, source = "tool" } = {}) {
  const recordingFetch = createRecordingFetch([{ body: { id: "new1" } }]);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "ya29.drive-token-1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("tool calls that set a parent folder are refused without GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST", async () => {
  for (const [operationName, args] of parentSettingCalls) {
    const { error, calls } = await runDrive(operationName, args);
    assert.equal(error?.kind, "permission_denied", operationName);
    assert.match(error.message, /GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST/);
    assert.equal(calls.length, 0);
  }
});

test("tool calls may use folders in the allowlist (or any with *); nodes are unaffected", async () => {
  for (const [operationName, args] of parentSettingCalls) {
    const listed = await runDrive(operationName, args, { environment: { [FOLDER_ALLOWLIST_ENV]: "f1, attacker" } });
    if (listed.error) throw listed.error;
    const wildcard = await runDrive(operationName, args, { environment: { [FOLDER_ALLOWLIST_ENV]: "*" } });
    if (wildcard.error) throw wildcard.error;
    const otherFolder = await runDrive(operationName, args, { environment: { [FOLDER_ALLOWLIST_ENV]: "f1" } });
    assert.equal(otherFolder.error?.kind, "permission_denied", operationName);
    const node = await runDrive(operationName, args, { source: "node" });
    if (node.error) throw node.error;
  }
});

test("tool calls without a parent folder keep working without the allowlist", async () => {
  for (const [operationName, args] of [["copy_file", { file_id: "a", name: "Copy" }], ["update_file", { file_id: "a", name: "Renamed" }], ["create_folder", { name: "x" }]]) {
    const { error } = await runDrive(operationName, args);
    if (error) throw error;
  }
});

test("upload_file as a tool may only target an allowlisted folder_id", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drive-folder-policy-"));
  try {
    const file = join(directory, "notes.txt");
    writeFileSync(file, "hello");
    const environment = { GOOGLE_DRIVE_UPLOAD_DIR: directory };
    const refused = await runDrive("upload_file", { file, folder_id: "attacker" }, { environment });
    assert.equal(refused.error?.kind, "permission_denied");
    assert.equal(refused.calls.length, 0);
    const allowed = await runDrive("upload_file", { file, folder_id: "f1" }, { environment: { ...environment, [FOLDER_ALLOWLIST_ENV]: "f1" } });
    if (allowed.error) throw allowed.error;
    const rootUpload = await runDrive("upload_file", { file }, { environment });
    if (rootUpload.error) throw rootUpload.error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest allows GOOGLE_DRIVE_TOOL_FOLDER_ALLOWLIST", () => {
  assert.ok(buildManifest(pluginDefinition).permissions.env.includes(FOLDER_ALLOWLIST_ENV));
});
