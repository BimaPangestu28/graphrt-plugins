import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const API = "https://docs.googleapis.com/v1";
const DOC = "1AbC-dEf_ghI";

describeRestPluginContract(pluginDefinition, {
  checkAuth: (call, credential) => assert.equal(call.headers.authorization, `Bearer ${credential}`),
  operations: {
    get_document: {
      args: { document_id: DOC, include_tabs_content: true },
      request: { method: "GET", url: `${API}/documents/${DOC}`, query: { includeTabsContent: "true" } },
      response: { body: { documentId: DOC, title: "Notes", revisionId: "r1" } },
      expect: { data: { documentId: DOC, title: "Notes", revisionId: "r1" } },
    },
    create_document: { args: { title: "Meeting notes" }, request: { method: "POST", url: `${API}/documents`, query: "absent", json: { title: "Meeting notes" } }, response: { body: { documentId: "new1" } } },
    insert_text: {
      args: { document_id: DOC, text: "Hello\n", index: 1, tab_id: "t.0" },
      request: { method: "POST", url: `${API}/documents/${DOC}:batchUpdate`, query: "absent", json: { requests: [{ insertText: { text: "Hello\n", location: { index: 1, tabId: "t.0" } } }] } },
      response: { body: { documentId: DOC, replies: [{}] } },
    },
    replace_all_text: {
      args: { document_id: DOC, find: "{{name}}", replace_with: "Ada", required_revision_id: "r1" },
      request: {
        method: "POST",
        url: `${API}/documents/${DOC}:batchUpdate`,
        query: "absent",
        json: { requests: [{ replaceAllText: { containsText: { text: "{{name}}", matchCase: false }, replaceText: "Ada" } }], writeControl: { requiredRevisionId: "r1" } },
      },
      response: { body: { replies: [{ replaceAllText: { occurrencesChanged: 2 } }] } },
    },
    batch_update: {
      args: { document_id: DOC, requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }] },
      request: { method: "POST", url: `${API}/documents/${DOC}:batchUpdate`, query: "absent", json: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 5 } } }] } },
    },
  },
});

async function runDocs(operationName, args, { source = "tool", environment = {} } = {}) {
  const recordingFetch = createRecordingFetch([{ body: { replies: [{}] } }]);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "ya29.docs-token-1", ...environment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("insert_text without an index appends at the end of the body", async () => {
  const { calls, error } = await runDocs("insert_text", { document_id: DOC, text: "Appendix" });
  if (error) throw error;
  assert.deepEqual(calls[0].json, { requests: [{ insertText: { text: "Appendix", endOfSegmentLocation: {} } }] });
});

test("replace_all_text can limit tabs and match case", async () => {
  const { calls, error } = await runDocs("replace_all_text", { document_id: DOC, find: "DRAFT", replace_with: "FINAL", match_case: true, tab_ids: ["t.1"] });
  if (error) throw error;
  assert.deepEqual(calls[0].json.requests[0], { replaceAllText: { containsText: { text: "DRAFT", matchCase: true }, replaceText: "FINAL", tabsCriteria: { tabIds: ["t.1"] } } });
});

test("replace_all_text without replace_with or delete_matches is refused (never deletes by default)", async () => {
  for (const args of [{ document_id: DOC, find: "e" }, { document_id: DOC, find: "e", replace_with: "" }, { document_id: DOC, find: "e", delete_matches: false }]) {
    const { error, calls } = await runDocs("replace_all_text", args, { source: "node" });
    assert.equal(error?.kind, "invalid_input", JSON.stringify(args));
    assert.equal(calls.length, 0);
  }
  const both = await runDocs("replace_all_text", { document_id: DOC, find: "e", replace_with: "x", delete_matches: true }, { source: "node" });
  assert.equal(both.error?.kind, "invalid_input");
});

test("replace_all_text delete_matches deletes from nodes, and from tools only with GOOGLE_DOCS_TOOL_ALLOW_BATCH_UPDATE=1", async () => {
  const node = await runDocs("replace_all_text", { document_id: DOC, find: "DRAFT", delete_matches: true }, { source: "node" });
  if (node.error) throw node.error;
  assert.equal(node.calls[0].json.requests[0].replaceAllText.replaceText, "");
  const tool = await runDocs("replace_all_text", { document_id: DOC, find: "DRAFT", delete_matches: true });
  assert.equal(tool.error?.kind, "permission_denied");
  assert.equal(tool.calls.length, 0);
  const allowed = await runDocs("replace_all_text", { document_id: DOC, find: "DRAFT", delete_matches: true }, { environment: { GOOGLE_DOCS_TOOL_ALLOW_BATCH_UPDATE: "1" } });
  if (allowed.error) throw allowed.error;
  assert.equal(allowed.calls.length, 1);
});

test("wrapped operations show plain fields; insert_text needs text", async () => {
  const insertTool = buildManifest(pluginDefinition).tools.find((tool) => tool.name === "insert_text");
  assert.deepEqual(insertTool.parameters.required, ["document_id", "text"]);
  assert.equal("requests" in insertTool.parameters.properties, false);
  const { error, calls } = await runDocs("insert_text", { document_id: DOC });
  assert.equal(error.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

test("Docs errors map by error.status", async () => {
  const recordingFetch = createRecordingFetch([{ status: 403, body: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } }]);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_ACCESS_TOKEN: "ya29.docs-token-1" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("get_document", { document_id: DOC }, { source: "tool" }), (error) => error.kind === "permission_denied" && /\(PERMISSION_DENIED\)/.test(error.message));
});
