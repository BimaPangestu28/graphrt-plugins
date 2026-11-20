import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { toolContext } from "../lib/graphrt-plugin.mjs";
import { createOperationRunner, createToolHandler, startPlugin } from "../lib/operations.mjs";

const echoContextOperation = {
  name: "whoami",
  title: "Who am I",
  description: "Echo the context names",
  parameters: { type: "object", properties: {} },
  run: async ({ toolContext: callContext, source }) => ({ data: { source, names: Object.keys(callContext.secrets) } }),
};
const pluginDefinition = {
  name: "demo",
  noCredentials: true,
  createClient: () => ({}),
  operations: [echoContextOperation, { ...echoContextOperation, name: "other" }],
};

test("toolContext keeps only string secrets and is frozen", () => {
  const normalized = toolContext({ secrets: { user_jwt: "a.b.c", count: 3, nested: {} } });
  assert.deepEqual(normalized.secrets, { user_jwt: "a.b.c" });
  assert.ok(Object.isFrozen(normalized) && Object.isFrozen(normalized.secrets));
  assert.deepEqual(toolContext(undefined).secrets, {});
  assert.deepEqual(toolContext({ secrets: ["x"] }).secrets, {});
});

test("tool handlers pass the call context to the operation; nodes never get one", async () => {
  const runOperation = createOperationRunner(pluginDefinition, {});
  const handler = createToolHandler(runOperation, "whoami", 5000);
  const toolOutput = await handler({}, toolContext({ secrets: { user_jwt: "a.b.c" } }));
  assert.deepEqual(toolOutput.data.data, { source: "tool", names: ["user_jwt"] });
  const legacyOutput = await handler({});
  assert.deepEqual(legacyOutput.data.data.names, []);
  const nodeOutput = await runOperation("whoami", {}, { source: "node", toolContext: toolContext({ secrets: { user_jwt: "a.b.c" } }) });
  assert.deepEqual(nodeOutput.data.names, []);
});

async function talkToPlugin(definition, environment, requests) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on("data", (chunk) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
  const running = startPlugin(definition, environment, { input, output });
  for (const request of requests) input.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
  for (let waitedMs = 0; lines.length < requests.length && waitedMs < 2000; waitedMs += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  input.end();
  await running;
  return lines.map((line) => JSON.parse(line));
}

test("over the protocol, tool.call context reaches the operation and resolveToolOperations picks the tools", async () => {
  const definition = { ...pluginDefinition, resolveToolOperations: (environment) => (environment.ONLY_WHOAMI ? [echoContextOperation] : undefined) };
  const replies = await talkToPlugin(definition, { ONLY_WHOAMI: "1" }, [
    { id: 1, method: "initialize", params: { protocol_version: 1, features: ["tool_context"] } },
    { id: 2, method: "tool.call", params: { request_id: "2", name: "whoami", arguments: {}, context: { secrets: { user_jwt: "a.b.c" } } } },
    { id: 3, method: "tool.call", params: { request_id: "3", name: "other", arguments: {} } },
  ]);
  const byId = Object.fromEntries(replies.map((reply) => [reply.id, reply]));
  assert.deepEqual(byId[1].result.tools.map((tool) => tool.name), ["whoami"]);
  assert.deepEqual(byId[1].result.nodes, undefined);
  assert.deepEqual(byId[2].result.data.data.names, ["user_jwt"]);
  assert.equal(byId[3].error.data.kind, "unknown_tool");

  const defaultReplies = await talkToPlugin(definition, {}, [{ id: 1, method: "initialize", params: { protocol_version: 1 } }]);
  assert.deepEqual(defaultReplies[0].result.tools.map((tool) => tool.name), ["whoami", "other"]);
});
