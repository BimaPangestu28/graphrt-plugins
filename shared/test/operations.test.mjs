import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDescriptors, createOperationRunner } from "../lib/operations.mjs";

const pluginDefinition = {
  name: "demo",
  tokenEnv: "DEMO_ACCESS_TOKEN",
  createClient: ({ accessToken }) => ({ accessToken }),
  operations: [
    {
      name: "get_profile",
      title: "Get profile",
      description: "Read the profile",
      parameters: { type: "object", properties: { fields: { type: "string", default: "id" } } },
      run: async ({ client, args }) => ({ data: { token: client.accessToken, fields: args.fields } }),
    },
    {
      name: "list_posts",
      title: "List posts",
      description: "List posts",
      parameters: { type: "object", properties: { limit: { type: "integer", default: 10 } } },
      run: async ({ args }) => ({ data: [{ id: "1" }], next_cursor: "c2", limit: args.limit }),
    },
  ],
};

test("buildDescriptors creates one node and one tool per operation", () => {
  const { nodes, tools } = buildDescriptors(pluginDefinition);
  assert.deepEqual(
    nodes.map((node) => node.kind),
    ["demo.get_profile", "demo.list_posts"],
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["get_profile", "list_posts"],
  );
  assert.deepEqual(
    nodes[0].outputs.map((output) => output.name),
    ["data", "next_cursor"],
  );
  assert.equal(nodes[0].category, "integration");
});

test("node config schema adds an optional access_token, tool parameters do not", () => {
  const { nodes, tools } = buildDescriptors(pluginDefinition);
  assert.equal(nodes[0].config_schema.properties.access_token.type, "string");
  assert.equal("access_token" in tools[0].parameters.properties, false);
});

test("runner uses the env token for tools and validates arguments", async () => {
  const runOperation = createOperationRunner(pluginDefinition, { DEMO_ACCESS_TOKEN: "env-token" });
  const output = await runOperation("get_profile", {}, { source: "tool" });
  assert.deepEqual(output, { data: { token: "env-token", fields: "id" }, next_cursor: null });
});

test("runner lets a node override the token via config but ignores it for tools", async () => {
  const runOperation = createOperationRunner(pluginDefinition, { DEMO_ACCESS_TOKEN: "env-token" });
  const nodeOutput = await runOperation("get_profile", { access_token: "node-token" }, { source: "node" });
  assert.equal(nodeOutput.data.token, "node-token");
  const toolOutput = await runOperation("get_profile", { access_token: "llm-token" }, { source: "tool" });
  assert.equal(toolOutput.data.token, "env-token");
});

test("runner fails with auth_error naming the env var when no token is set", async () => {
  const runOperation = createOperationRunner(pluginDefinition, {});
  await assert.rejects(
    runOperation("get_profile", {}, { source: "tool" }),
    (error) => error.kind === "auth_error" && error.message.includes("DEMO_ACCESS_TOKEN"),
  );
});

test("runner keeps only data and next_cursor in the output", async () => {
  const runOperation = createOperationRunner(pluginDefinition, { DEMO_ACCESS_TOKEN: "t" });
  assert.deepEqual(await runOperation("list_posts", { limit: "3" }, { source: "node" }), {
    data: [{ id: "1" }],
    next_cursor: "c2",
  });
});

test("runner rejects an unknown operation", async () => {
  const runOperation = createOperationRunner(pluginDefinition, { DEMO_ACCESS_TOKEN: "t" });
  await assert.rejects(runOperation("nope", {}, { source: "tool" }), (error) => error.kind === "invalid_input");
});

test("resolveAccessToken hook replaces the default token lookup", async () => {
  const definitionWithResolver = {
    ...pluginDefinition,
    resolveAccessToken: ({ environment, nodeToken }) => nodeToken ?? environment.ALT_TOKEN ?? null,
  };
  const runOperation = createOperationRunner(definitionWithResolver, { ALT_TOKEN: "alt" });
  assert.equal((await runOperation("get_profile", {}, { source: "tool" })).data.token, "alt");
  const runWithoutToken = createOperationRunner(definitionWithResolver, {});
  assert.equal((await runWithoutToken("get_profile", {}, { source: "tool" })).data.token, null);
});

test("buildManifest lists the token and extra env vars and merges limits", async () => {
  const { buildManifest } = await import("../lib/operations.mjs");
  const manifest = buildManifest({ ...pluginDefinition, version: "0.1.0", description: "d", extraEnv: ["DEMO_ID"], limits: { timeout_ms: 5 } });
  assert.deepEqual(manifest.permissions.env, ["DEMO_ACCESS_TOKEN", "DEMO_ID"]);
  assert.equal(manifest.limits.timeout_ms, 5);
  assert.equal(manifest.limits.max_concurrency, 8);
  assert.equal(manifest.runtime, "process");
});

test("buildManifest requests plaintext secrets so the node token override can work", async () => {
  const { buildManifest } = await import("../lib/operations.mjs");
  assert.equal(buildManifest({ ...pluginDefinition, version: "0", description: "d" }).permissions.secrets, true);
});

test("a masked node token fails with a hint about --trust-plugin", async () => {
  const runOperation = createOperationRunner(pluginDefinition, { DEMO_ACCESS_TOKEN: "env" });
  await assert.rejects(
    runOperation("get_profile", { access_token: "******" }, { source: "node" }),
    (error) => error.kind === "auth_error" && /--trust-plugin/.test(error.message),
  );
});

test("an async resolveAccessToken is awaited", async () => {
  const runOperation = createOperationRunner({ ...pluginDefinition, resolveAccessToken: async () => "async-token" }, {});
  assert.equal((await runOperation("get_profile", {}, { source: "tool" })).data.token, "async-token");
});

test("nodeOnly operations become nodes but never tools, so credentials stay out of LLM context", async () => {
  const definitionWithNodeOnly = {
    ...pluginDefinition,
    operations: [
      ...pluginDefinition.operations,
      { name: "refresh_access_token", title: "Refresh", description: "d", nodeOnly: true, parameters: { type: "object", properties: {} }, run: async () => ({ data: { access_token: "new" } }) },
    ],
  };
  const { nodes, tools } = buildDescriptors(definitionWithNodeOnly);
  assert.ok(nodes.some((node) => node.kind === "demo.refresh_access_token"));
  assert.equal(tools.some((tool) => tool.name === "refresh_access_token"), false);
  const runOperation = createOperationRunner(definitionWithNodeOnly, { DEMO_ACCESS_TOKEN: "t" });
  await assert.rejects(runOperation("refresh_access_token", {}, { source: "tool" }), (error) => error.kind === "invalid_input");
  assert.equal((await runOperation("refresh_access_token", {}, { source: "node" })).data.access_token, "new");
});

test("localOnly plugins request no network or secrets and offer no node access_token", async () => {
  const { buildManifest } = await import("../lib/operations.mjs");
  const manifest = buildManifest({ ...pluginDefinition, version: "0", description: "d", localOnly: true });
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  assert.deepEqual(manifest.permissions.env, ["DEMO_ACCESS_TOKEN"]);
  assert.equal("access_token" in manifest.nodes[0].config_schema.properties, false);
  assert.equal(buildManifest({ ...pluginDefinition, version: "0", description: "d" }).permissions.network, true);
});

test("resolveToolDeadlineMs leaves 10 s of the host timeout, with a 5 s floor and the 120 s default", async () => {
  const { resolveToolDeadlineMs } = await import("../lib/operations.mjs");
  assert.equal(resolveToolDeadlineMs(pluginDefinition), 110000);
  assert.equal(resolveToolDeadlineMs({ ...pluginDefinition, limits: { timeout_ms: 60000 } }), 50000);
  assert.equal(resolveToolDeadlineMs({ ...pluginDefinition, limits: { timeout_ms: 8000 } }), 5000);
});

test("tool handlers pass a deadline signal that aborts the operation", async () => {
  const { createToolHandler } = await import("../lib/operations.mjs");
  const receivedCalls = [];
  const runOperation = async (operationName, toolArguments, options) => {
    receivedCalls.push({ operationName, toolArguments, options });
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    return { data: { aborted: options.signal.aborted, reason: options.signal.reason?.name }, next_cursor: null };
  };
  const handleTool = createToolHandler(runOperation, "get_profile", 20);
  // AbortSignal.timeout's timer does not keep the event loop alive on its own.
  const keepAliveTimer = setTimeout(() => {}, 5000);
  const result = await handleTool({ fields: "id" }).finally(() => clearTimeout(keepAliveTimer));
  assert.equal(receivedCalls[0].operationName, "get_profile");
  assert.equal(receivedCalls[0].options.source, "tool");
  assert.deepEqual(result.data, { data: { aborted: true, reason: "TimeoutError" }, next_cursor: null });
  assert.equal(result.text, JSON.stringify(result.data));
});

test("operations receive the call source (node or tool)", async () => {
  const sources = [];
  const definitionWithSource = {
    ...pluginDefinition,
    operations: [{ name: "probe", title: "Probe", description: "d", parameters: { type: "object", properties: {} }, run: async ({ source }) => (sources.push(source), { data: null }) }],
  };
  const runOperation = createOperationRunner(definitionWithSource, { DEMO_ACCESS_TOKEN: "t" });
  await runOperation("probe", {}, { source: "tool" });
  await runOperation("probe", {}, { source: "node" });
  assert.deepEqual(sources, ["tool", "node"]);
});

test("noCredentials plugins use the network but ask for no secrets, need no token and offer no node access_token", async () => {
  const { buildManifest } = await import("../lib/operations.mjs");
  const publicDefinition = { ...pluginDefinition, tokenEnv: undefined, noCredentials: true, version: "0", description: "d", extraEnv: ["DEMO_REGION"] };
  const manifest = buildManifest(publicDefinition);
  assert.equal(manifest.permissions.network, true);
  assert.equal(manifest.permissions.secrets, false);
  assert.deepEqual(manifest.permissions.env, ["DEMO_REGION"]);
  assert.equal("access_token" in manifest.nodes[0].config_schema.properties, false);
  const runOperation = createOperationRunner(publicDefinition, {});
  assert.equal((await runOperation("get_profile", { access_token: "ignored" }, { source: "node" })).data.token, undefined);
});

test("buildManifest drops an undefined token env and duplicate env names", async () => {
  const { buildManifest } = await import("../lib/operations.mjs");
  const manifest = buildManifest({ ...pluginDefinition, version: "0", description: "d", extraEnv: ["DEMO_ACCESS_TOKEN", "DEMO_ID", "DEMO_ID"] });
  assert.deepEqual(manifest.permissions.env, ["DEMO_ACCESS_TOKEN", "DEMO_ID"]);
});

test("runner passes a test resolveHostAddresses through to createClient", async () => {
  const receivedOptions = [];
  const definitionWithProbe = { ...pluginDefinition, createClient: (clientOptions) => (receivedOptions.push(clientOptions), {}) };
  const fakeResolver = async () => ["93.184.216.34"];
  const environment = { DEMO_ACCESS_TOKEN: "t" };
  await createOperationRunner(definitionWithProbe, environment, { resolveHostAddresses: fakeResolver })("get_profile", {}, { source: "tool" });
  await createOperationRunner(definitionWithProbe, environment)("get_profile", {}, { source: "tool" });
  assert.equal(receivedOptions[0].resolveHostAddresses, fakeResolver);
  assert.equal("resolveHostAddresses" in receivedOptions[1], false);
});
