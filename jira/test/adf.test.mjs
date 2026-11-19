import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { textToAdf } from "../lib/adf.mjs";
import { pluginDefinition } from "../definition.mjs";

const environment = { JIRA_SITE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "ana@acme.test", JIRA_API_TOKEN: "token" };

async function runAsTool(operationName, args, responses = [{ status: 201, body: { id: "1" } }]) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ...environment, JIRA_TOOL_ALLOW_WRITE: "1" }, { fetchImpl: recordingFetch });
  const result = await run(operationName, args, { source: "tool" });
  return { result, calls: recordingFetch.calls };
}

test("textToAdf turns paragraphs into ADF paragraphs and single line breaks into hardBreaks", () => {
  assert.deepEqual(textToAdf("First line\nsecond line\n\nNext paragraph"), {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "First line" }, { type: "hardBreak" }, { type: "text", text: "second line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Next paragraph" }] },
    ],
  });
});

test("textToAdf normalizes CRLF, drops empty lines inside a paragraph and keeps an empty document valid", () => {
  assert.deepEqual(textToAdf("a\r\n\r\n\r\nb").content.length, 2);
  assert.deepEqual(textToAdf("   "), { type: "doc", version: 1, content: [] });
});

test("add_comment takes plain `text` and sends it as an ADF body", async () => {
  const { calls } = await runAsTool("add_comment", { issue_key: "OPS-1", text: "Deployed\n\nAll green" });
  assert.deepEqual(calls[0].json, { body: textToAdf("Deployed\n\nAll green") });
});

test("add_comment still accepts a ready ADF `body`", async () => {
  const adfBody = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "strong" }] }] }] };
  const { calls } = await runAsTool("add_comment", { issue_key: "OPS-1", body: adfBody });
  assert.deepEqual(calls[0].json, { body: adfBody });
});

test("add_comment refuses both `text` and `body`, and neither, before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, { ...environment, JIRA_TOOL_ALLOW_WRITE: "1" }, { fetchImpl: recordingFetch });
  await assert.rejects(run("add_comment", { issue_key: "OPS-1" }, { source: "tool" }), (error) => error.kind === "invalid_input" && /text/.test(error.message));
  await assert.rejects(run("add_comment", { issue_key: "OPS-1", text: "a", body: textToAdf("b") }, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal(recordingFetch.calls.length, 0);
});

test("create_issue and update_issue take description_text as plain text", async () => {
  const created = await runAsTool("create_issue", { project_key: "OPS", issue_type: "Task", summary: "Rotate keys", description_text: "Before Friday" });
  assert.deepEqual(created.calls[0].json.fields.description, textToAdf("Before Friday"));
  const updated = await runAsTool("update_issue", { issue_key: "OPS-1", description_text: "Done" }, [{ status: 204 }]);
  assert.deepEqual(updated.calls[0].json, { fields: { description: textToAdf("Done") } });
});

test("the text parameters are in the tool schema", () => {
  const tools = Object.fromEntries(buildManifest(pluginDefinition).tools.map((tool) => [tool.name, tool]));
  assert.equal(tools.add_comment.parameters.properties.text.type, "string");
  assert.equal(tools.create_issue.parameters.properties.description_text.type, "string");
});

test("whitespace-only plain text is refused before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, { ...environment, JIRA_TOOL_ALLOW_WRITE: "1" }, { fetchImpl: recordingFetch });
  for (const blankText of ["", "   ", "\n\n \t\n"]) {
    await assert.rejects(run("add_comment", { issue_key: "OPS-1", text: blankText }, { source: "tool" }), (error) => error.kind === "invalid_input" && /empty|required/.test(error.message));
    await assert.rejects(run("update_issue", { issue_key: "OPS-1", description_text: blankText }, { source: "node" }), (error) => error.kind === "invalid_input");
  }
  assert.equal(recordingFetch.calls.length, 0);
});

test("update_issue with no field to change is refused before any request", async () => {
  const recordingFetch = createRecordingFetch([]);
  const run = createOperationRunner(pluginDefinition, environment, { fetchImpl: recordingFetch });
  await assert.rejects(run("update_issue", { issue_key: "OPS-1", notify_users: false }, { source: "node" }), (error) => error.kind === "invalid_input" && error.message.includes("at least one field"));
  assert.equal(recordingFetch.calls.length, 0);
});
