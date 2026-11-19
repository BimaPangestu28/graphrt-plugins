import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { FOLDER_ALLOWLIST_ENV } from "../lib/folder-policy.mjs";
import { stripPreauthenticatedUrls } from "../lib/tool-output.mjs";
import { escapeODataString } from "../lib/search-query.mjs";
import { pluginDefinition } from "../definition.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const NODE_TOKEN = "eyJ-onedrive-node-token-0001";
const OAUTH_ENV = { MICROSOFT_CLIENT_ID: "client-1", MICROSOFT_CLIENT_SECRET: "secret-0001", MICROSOFT_REFRESH_TOKEN: "refresh-0001" };
const TOKEN_HOST = "https://login.microsoftonline.com/";
const TOKEN_BODY = { access_token: "eyJ-onedrive-tool-token-0001", expires_in: 3600 };
const DOWNLOAD_URL = "https://contoso-my.sharepoint.com/personal/ada/_layouts/15/download.aspx?UniqueId=1&tempauth=v1.secret";
const publicResolver = async () => ["93.184.216.34"];

async function runOneDrive(operationName, args, { environment = {}, source = "tool", responses = [] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  // The OAuth token is cached across tests, so the token endpoint is answered on the side, not from `responses`.
  const fetchWithTokenEndpoint = (url, init) => (String(url).startsWith(TOKEN_HOST) ? Promise.resolve(Response.json(TOKEN_BODY)) : recordingFetch(url, init));
  const run = createOperationRunner(pluginDefinition, { ...OAUTH_ENV, ...environment }, { fetchImpl: fetchWithTokenEndpoint, resolveHostAddresses: publicResolver });
  const callArgs = source === "node" ? { ...args, access_token: NODE_TOKEN } : args;
  const outcome = await run(operationName, callArgs, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("escapeODataString doubles single quotes", () => {
  assert.equal(escapeODataString("Ada's 'plan'"), "Ada''s ''plan''");
});

test("search escapes quotes in the OData function argument", async () => {
  const { error, calls } = await runOneDrive("search", { query: "Ada's plan" }, { source: "node", responses: [{ body: { value: [] } }] });
  if (error) throw error;
  assert.equal(calls[0].path, "/v1.0/me/drive/root/search(q='Ada''s%20plan')");
});

test("stripPreauthenticatedUrls removes download URLs and sharing-link URLs at any depth", () => {
  const stripped = stripPreauthenticatedUrls({
    value: [{ id: "1", webUrl: "https://onedrive.live.com/x", "@microsoft.graph.downloadUrl": DOWNLOAD_URL, "@content.downloadUrl": DOWNLOAD_URL }],
    link: { type: "view", scope: "anonymous", webUrl: "https://1drv.ms/u/s!secret", webHtml: "<iframe>" },
  });
  assert.deepEqual(stripped, { value: [{ id: "1", webUrl: "https://onedrive.live.com/x" }], link: { type: "view", scope: "anonymous" } });
});

test("tool results never contain @microsoft.graph.downloadUrl; nodes get it", async () => {
  const itemBody = { id: "01ABC", name: "q3.pdf", "@microsoft.graph.downloadUrl": DOWNLOAD_URL };
  const toolRun = await runOneDrive("get_item", { item_id: "01ABC" }, { responses: [{ body: itemBody }] });
  if (toolRun.error) throw toolRun.error;
  assert.deepEqual(toolRun.output.data, { id: "01ABC", name: "q3.pdf" });
  const listRun = await runOneDrive("list_children", { item_id: "01ABC" }, { responses: [{ body: { value: [itemBody] } }] });
  assert.deepEqual(listRun.output.data, [{ id: "01ABC", name: "q3.pdf" }]);
  const apiRequestRun = await runOneDrive("api_request", { path: "/me/drive/items/01ABC" }, { responses: [{ body: itemBody }] });
  assert.ok(!JSON.stringify(apiRequestRun.output.data).includes("tempauth"));
  const nodeRun = await runOneDrive("get_item", { item_id: "01ABC" }, { source: "node", responses: [{ body: itemBody }] });
  assert.equal(nodeRun.output.data["@microsoft.graph.downloadUrl"], DOWNLOAD_URL);
});

test("download_item reads the download URL, fetches it without the bearer token and returns only the saved file", async () => {
  const downloadDirectory = mkdtempSync(join(tmpdir(), "onedrive-download-"));
  const { output, error, calls } = await runOneDrive("download_item", { item_id: "01ABC" }, {
    environment: { ONEDRIVE_DOWNLOAD_DIR: downloadDirectory },
    responses: [{ body: { id: "01ABC", name: "q3.pdf", size: 9, file: {}, "@microsoft.graph.downloadUrl": DOWNLOAD_URL } }, { body: "PDF-BYTES", headers: { "content-type": "application/pdf" } }],
  });
  if (error) throw error;
  assert.equal(calls[0].url, `${GRAPH}/me/drive/items/01ABC?%24select=id%2Cname%2Csize%2Cfile%2C%40microsoft.graph.downloadUrl`);
  assert.equal(calls[1].url, DOWNLOAD_URL);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(readFileSync(output.data.path, "utf8"), "PDF-BYTES");
  assert.deepEqual({ ...output.data, path: undefined }, { item: { id: "01ABC", name: "q3.pdf", size: 9 }, path: undefined, bytes: 9, content_type: "application/pdf" });
  assert.ok(!JSON.stringify(output).includes("tempauth"));
});

test("download_item errors never contain the pre-authenticated download URL", async () => {
  const downloadDirectory = mkdtempSync(join(tmpdir(), "onedrive-download-"));
  const { error } = await runOneDrive("download_item", { item_id: "01ABC" }, {
    environment: { ONEDRIVE_DOWNLOAD_DIR: downloadDirectory },
    responses: [{ body: { id: "01ABC", name: "q3.pdf", size: 9, file: {}, "@microsoft.graph.downloadUrl": DOWNLOAD_URL } }, { status: 403, body: "denied" }],
  });
  assert.equal(error?.kind, "api_error");
  assert.ok(!error.message.includes("tempauth"), error.message);
  assert.match(error.message, /HTTP 403/);
});

test("download_item refuses download hosts that are not OneDrive/SharePoint, folders, and a missing directory", async () => {
  const downloadDirectory = mkdtempSync(join(tmpdir(), "onedrive-download-"));
  const environment = { ONEDRIVE_DOWNLOAD_DIR: downloadDirectory };
  const foreignHost = await runOneDrive("download_item", { item_id: "1" }, { environment, responses: [{ body: { id: "1", file: {}, "@microsoft.graph.downloadUrl": "https://attacker.example/x" } }] });
  assert.equal(foreignHost.error?.kind, "invalid_input");
  assert.equal(foreignHost.calls.length, 1);
  const folder = await runOneDrive("download_item", { item_id: "1" }, { environment, responses: [{ body: { id: "1", folder: {} } }] });
  assert.equal(folder.error?.kind, "invalid_input");
  const noDirectory = await runOneDrive("download_item", { item_id: "1" }, {});
  assert.equal(noDirectory.error?.kind, "invalid_input");
  assert.match(noDirectory.error.message, /ONEDRIVE_DOWNLOAD_DIR/);
  assert.equal(noDirectory.calls.length, 0);
});

const parentSettingCalls = [
  ["create_folder", { parent_id: "shared-folder", name: "x" }],
  ["upload_file", { parent_id: "shared-folder", file_name: "a.txt", file: "https://files.example/a.txt" }],
  ["update_item", { item_id: "a", parent_id: "shared-folder" }],
  ["copy_item", { item_id: "a", parent_id: "shared-folder" }],
];

test("tool calls that put an item into a folder other than root need ONEDRIVE_TOOL_FOLDER_ALLOWLIST", async () => {
  for (const [operationName, args] of parentSettingCalls) {
    const refused = await runOneDrive(operationName, args);
    assert.equal(refused.error?.kind, "permission_denied", operationName);
    assert.match(refused.error.message, new RegExp(FOLDER_ALLOWLIST_ENV));
    assert.equal(refused.calls.length, 0, operationName);
    const otherFolder = await runOneDrive(operationName, args, { environment: { [FOLDER_ALLOWLIST_ENV]: "agent-folder" } });
    assert.equal(otherFolder.error?.kind, "permission_denied", operationName);
  }
});

test("allowlisted folders, *, root and node calls are not limited", async () => {
  for (const [operationName, args] of parentSettingCalls) {
    if (operationName === "upload_file") continue;
    const listed = await runOneDrive(operationName, args, { environment: { [FOLDER_ALLOWLIST_ENV]: "agent-folder, shared-folder" }, responses: [{ body: { id: "n1" } }] });
    if (listed.error) throw listed.error;
    const wildcard = await runOneDrive(operationName, args, { environment: { [FOLDER_ALLOWLIST_ENV]: "*" }, responses: [{ body: { id: "n1" } }] });
    if (wildcard.error) throw wildcard.error;
    const rootTarget = await runOneDrive(operationName, { ...args, parent_id: "root" }, { responses: [{ body: { id: "n1" } }] });
    if (rootTarget.error) throw rootTarget.error;
    const node = await runOneDrive(operationName, args, { source: "node", responses: [{ body: { id: "n1" } }] });
    if (node.error) throw node.error;
  }
});

test("tool names with /, \\ or : are refused, so a path cannot escape the checked parent folder", async () => {
  const pathLikeCalls = [
    ["upload_file", { parent_id: "root", file_name: "SharedShortcut/leak.txt", file: "https://files.example/a.txt" }],
    ["upload_file", { parent_id: "root", file_name: "Shared\\leak.txt", file: "https://files.example/a.txt" }],
    ["upload_file", { parent_id: "root", file_name: "root:/Shared/leak.txt", file: "https://files.example/a.txt" }],
    ["create_folder", { parent_id: "root", name: "Shared/x" }],
    ["update_item", { item_id: "a", name: "Shared/b.txt" }],
    ["copy_item", { item_id: "a", parent_id: "root", name: "Shared:b.txt" }],
  ];
  for (const [operationName, args] of pathLikeCalls) {
    const refused = await runOneDrive(operationName, args);
    assert.equal(refused.error?.kind, "permission_denied", `${operationName} ${JSON.stringify(args)}`);
    assert.equal(refused.calls.length, 0);
  }
  const node = await runOneDrive("create_folder", { parent_id: "root", name: "a:b" }, { source: "node", responses: [{ body: { id: "n1" } }] });
  assert.equal(node.error, undefined);
});

test("copy_item refuses parent_drive_id for tools (another drive), and allows it for nodes", async () => {
  const refused = await runOneDrive("copy_item", { item_id: "a", parent_id: "root", parent_drive_id: "b!otherdrive" });
  assert.equal(refused.error?.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const node = await runOneDrive("copy_item", { item_id: "a", parent_id: "root", parent_drive_id: "b!otherdrive" }, { source: "node", responses: [{ body: {} }] });
  assert.equal(node.error, undefined);
});

test("tool results never contain thumbnail URLs", async () => {
  const thumbnails = { value: [{ id: "0", small: { height: 96, width: 96, url: "https://contoso.sharepoint.com/thumb?tempauth=x" }, large: { url: "https://x.1drv.com/t" }, c300x400_crop: { url: "https://x.1drv.com/c" } }] };
  const { output, error } = await runOneDrive("api_request", { path: "/me/drive/items/1/thumbnails" }, { responses: [{ body: thumbnails }] });
  if (error) throw error;
  assert.deepEqual(output.data, { value: [{ id: "0", small: { height: 96, width: 96 }, large: {}, c300x400_crop: {} }] });
  assert.deepEqual(stripPreauthenticatedUrls({ thumbnails: [{ medium: { url: "u" }, source: { url: "s" } }] }), { thumbnails: [{ medium: {}, source: {} }] });
});

test("download URLs on *.microsoftpersonalcontent.com (personal OneDrive) are accepted and fetched without the bearer", async () => {
  const downloadDirectory = mkdtempSync(join(tmpdir(), "onedrive-download-"));
  const personalUrl = "https://my.microsoftpersonalcontent.com/personal/abc/_layouts/15/download.aspx?tempauth=v1.p";
  const { output, error, calls } = await runOneDrive("download_item", { item_id: "01ABC" }, {
    environment: { ONEDRIVE_DOWNLOAD_DIR: downloadDirectory },
    responses: [{ body: { id: "01ABC", name: "a.txt", size: 3, file: {}, "@microsoft.graph.downloadUrl": personalUrl } }, { body: "abc", headers: { "content-type": "text/plain" } }],
  });
  if (error) throw error;
  assert.equal(calls[1].url, personalUrl);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(output.data.bytes, 3);
});

test("renaming in place needs no allowlist", async () => {
  const { error } = await runOneDrive("update_item", { item_id: "a", name: "b.txt" }, { responses: [{ body: { id: "a" } }] });
  if (error) throw error;
});

test("sharing links, invitations and deletes are node only", () => {
  for (const operationName of ["create_sharing_link", "invite", "delete_item"]) {
    assert.equal(pluginDefinition.operations.find((operation) => operation.name === operationName)?.nodeOnly, true, operationName);
  }
});
