import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { parseJsonLines, readJsonLinesStream } from "../lib/batch-results.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = "sk-ant-test-0001";
const succeeded = { custom_id: "a", result: { type: "succeeded", message: { content: [{ type: "text", text: "Hi" }] } } };
const errored = { custom_id: "b", result: { type: "errored", error: { type: "invalid_request_error" } } };

async function runResults(args, responses, source = "node") {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ANTHROPIC_API_KEY: API_KEY }, { fetchImpl: recordingFetch });
  const outcome = await run("get_message_batch_results", args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("parseJsonLines reads one JSON value per non-empty line", () => {
  assert.deepEqual(parseJsonLines(`${JSON.stringify(succeeded)}\n\n${JSON.stringify(errored)}\n`), [succeeded, errored]);
  assert.deepEqual(parseJsonLines(""), []);
});

test("parseJsonLines names the line that is not JSON", () => {
  assert.throws(() => parseJsonLines('{"a":1}\nnot json'), (error) => error.kind === "api_error" && /line 2/.test(error.message));
});

test("get_message_batch_results fetches the JSONL results with the key and version headers", async () => {
  const jsonl = `${JSON.stringify(succeeded)}\n${JSON.stringify(errored)}\n`;
  const { output, error, calls } = await runResults({ batch_id: "msgbatch_1" }, [{ body: jsonl, headers: { "content-type": "application/x-jsonl" } }]);
  if (error) throw error;
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers["x-api-key"], API_KEY);
  assert.equal(calls[0].headers["anthropic-version"], "2026-10-21");
  assert.deepEqual(output.data, [succeeded, errored]);
});

test("a single-line result file (parsed as one JSON object) still becomes a list", async () => {
  const { output } = await runResults({ batch_id: "msgbatch_1" }, [{ body: succeeded }]);
  assert.deepEqual(output.data, [succeeded]);
});

test("result_type filters the results", async () => {
  const jsonl = `${JSON.stringify(succeeded)}\n${JSON.stringify(errored)}`;
  const { output } = await runResults({ batch_id: "msgbatch_1", result_type: "errored" }, [{ body: jsonl }]);
  assert.deepEqual(output.data, [errored]);
});

test("the batch id stays one encoded path segment and '..' is refused", async () => {
  const escaping = await runResults({ batch_id: "../../v1/files" }, [{ body: "" }]);
  assert.equal(escaping.calls[0].path, "/v1/messages/batches/..%2F..%2Fv1%2Ffiles/results");
  const dotted = await runResults({ batch_id: ".." }, []);
  assert.equal(dotted.error?.kind, "invalid_input");
  assert.equal(dotted.calls.length, 0);
});

test("API errors are mapped and the key is redacted", async () => {
  const { error } = await runResults({ batch_id: "msgbatch_1" }, [{ status: 404, body: { type: "error", error: { type: "not_found_error", message: `no batch for ${API_KEY}` } } }]);
  assert.equal(error.kind, "not_found");
  assert.equal(error.message.includes(API_KEY), false);
});

test("tool results are truncated to keep the agent's context small", async () => {
  const manyLines = Array.from({ length: 300 }, (unused, index) => JSON.stringify({ ...succeeded, custom_id: `r${index}` })).join("\n");
  const { output } = await runResults({ batch_id: "msgbatch_1" }, [{ body: manyLines }], "tool");
  assert.equal(output.data.truncated, true);
  assert.equal(output.data.items.length, 100);
  assert.equal(output.data.total_items, 300);
});

test("get_message_batch_results is an agent tool and requires batch_id", async () => {
  assert.ok(buildManifest(pluginDefinition).tools.some((tool) => tool.name === "get_message_batch_results"));
  const { error, calls } = await runResults({}, []);
  assert.equal(error?.kind, "invalid_input");
  assert.equal(calls.length, 0);
});

const streamOf = (text) => new Response(text).body;

test("readJsonLinesStream parses lines split across chunks and stops past the byte cap", async () => {
  const chunks = ['{"a":', '1}\n{"a"', ":2}\n"];
  const chunkedStream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
  const parsed = [];
  await readJsonLinesStream(chunkedStream, { maxBytes: 1000, onValue: (value) => parsed.push(value) });
  assert.deepEqual(parsed, [{ a: 1 }, { a: 2 }]);
  await assert.rejects(readJsonLinesStream(streamOf("x".repeat(2000)), { maxBytes: 1000, onValue: () => {} }), (error) => error.kind === "api_error" && /larger than 1000 bytes/.test(error.message) && /custom_ids/.test(error.message));
});

test("custom_ids picks results by id and offset skips matching results", async () => {
  const lines = ["a", "b", "c", "d"].map((customId) => JSON.stringify({ custom_id: customId, result: { type: "succeeded" } })).join("\n");
  const picked = await runResults({ batch_id: "msgbatch_1", custom_ids: ["d", "b"] }, [{ body: lines }]);
  assert.deepEqual(picked.output.data.map((batchResult) => batchResult.custom_id), ["b", "d"]);
  const skipped = await runResults({ batch_id: "msgbatch_1", offset: 2 }, [{ body: lines }]);
  assert.deepEqual(skipped.output.data.map((batchResult) => batchResult.custom_id), ["c", "d"]);
});

test("results beyond the first 100 are reachable for tools with offset", async () => {
  const manyLines = Array.from({ length: 250 }, (unused, index) => JSON.stringify({ custom_id: `r${index}`, result: { type: "succeeded" } })).join("\n");
  const { output } = await runResults({ batch_id: "msgbatch_1", offset: 200 }, [{ body: manyLines }], "tool");
  assert.equal(output.data.length, 50);
  assert.equal(output.data[0].custom_id, "r200");
});

test("a key echoed inside a result line is redacted", async () => {
  const { output } = await runResults({ batch_id: "msgbatch_1" }, [{ body: JSON.stringify({ custom_id: "a", result: { type: "errored", error: { message: `bad ${API_KEY}` } } }) }]);
  assert.equal(JSON.stringify(output).includes(API_KEY), false);
});
