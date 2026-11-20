import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { toolContext } from "../lib/graphrt-plugin.mjs";
import { buildManifest, createOperationRunner, startPlugin } from "../lib/operations.mjs";
import { defineRestPlugin } from "../lib/rest-plugin.mjs";
import { toolTokenSourceEnv } from "../lib/tool-user-token.mjs";

const USER_TOKEN = "user-token-1234/abc";
const ENV_TOKEN = "env-token-should-never-be-used";
const CONTEXT_MODE = { DEMO_APP_TOOL_TOKEN_SOURCE: "context", DEMO_TOKEN: ENV_TOKEN, DEMO_REFRESH_TOKEN: "env-refresh", DEMO_REGION: "eu" };

// The client echoes its token and the env it saw, so tests can see exactly what an operation got.
const echoOperation = {
  name: "whoami",
  title: "Who am I",
  description: "Echo",
  parameters: { type: "object", properties: { echo: { type: "string" } } },
  run: async ({ client, environment, contextAccessToken, args }) => {
    if (args.echo === "fail") throw new Error(`upstream said: bad token ${client.token}`);
    return { data: { token: client.token, envNames: Object.keys(environment).sort(), contextAccessToken, echo: client.token } };
  },
};
const pluginDefinition = {
  name: "demo-app",
  tokenEnv: "DEMO_TOKEN",
  extraEnv: ["DEMO_REGION", "DEMO_REFRESH_TOKEN"],
  toolUserToken: { credentialEnv: ["DEMO_REFRESH_TOKEN"] },
  createClient: ({ accessToken }) => ({ token: accessToken }),
  operations: [echoOperation],
};
const withContext = (secrets) => toolContext({ secrets });

test("the source env is named after the plugin and declared in permissions.env only when opted in", () => {
  assert.equal(toolTokenSourceEnv(pluginDefinition), "DEMO_APP_TOOL_TOKEN_SOURCE");
  assert.ok(buildManifest(pluginDefinition).permissions.env.includes("DEMO_APP_TOOL_TOKEN_SOURCE"));
  const { toolUserToken, ...withoutOptIn } = pluginDefinition;
  assert.equal(toolTokenSourceEnv(withoutOptIn), undefined);
  assert.ok(!buildManifest(withoutOptIn).permissions.env.some((envName) => envName.endsWith("_TOOL_TOKEN_SOURCE")));
});

test("default mode is unchanged: tools use the env token and ignore context", async () => {
  for (const sourceValue of [undefined, "", "env", " ENV "]) {
    const runOperation = createOperationRunner(pluginDefinition, { DEMO_TOKEN: ENV_TOKEN, DEMO_APP_TOOL_TOKEN_SOURCE: sourceValue });
    const output = await runOperation("whoami", {}, { source: "tool", toolContext: withContext({ access_token: USER_TOKEN }) });
    assert.equal(output.data.token, ENV_TOKEN);
    assert.equal(output.data.contextAccessToken, undefined);
  }
});

test("context mode: tools use the context token, never see the env credential, and get the token as contextAccessToken", async () => {
  const runOperation = createOperationRunner(pluginDefinition, CONTEXT_MODE);
  const output = await runOperation("whoami", {}, { source: "tool", toolContext: withContext({ access_token: ` ${USER_TOKEN} ` }) });
  assert.equal(output.data.token, "[redacted]", "the token is scrubbed from results");
  assert.equal(output.data.contextAccessToken, "[redacted]");
  assert.deepEqual(output.data.envNames, ["DEMO_APP_TOOL_TOKEN_SOURCE", "DEMO_REGION"]);
  assert.ok(!JSON.stringify(output).includes(ENV_TOKEN));
});

test("context mode refuses tool calls without a usable token, without falling back to the env", async () => {
  const runOperation = createOperationRunner(pluginDefinition, CONTEXT_MODE);
  const badContexts = [undefined, withContext({}), withContext({ access_token: "" }), withContext({ access_token: "   " }), withContext({ access_token: "******" }), withContext({ access_token: "has space" }), withContext({ user_jwt: USER_TOKEN })];
  for (const badContext of badContexts) {
    await assert.rejects(runOperation("whoami", {}, { source: "tool", toolContext: badContext }), (error) => {
      assert.equal(error.kind, "auth_error");
      assert.ok(!error.message.includes(ENV_TOKEN) && !error.message.includes("has space"));
      return true;
    });
  }
  // The refusal comes before argument validation, so nothing about the call runs.
  await assert.rejects(runOperation("whoami", { echo: 5 }, { source: "tool" }), { kind: "auth_error" });
});

test("context mode leaves nodes on the env credential and node access_token", async () => {
  const runOperation = createOperationRunner(pluginDefinition, CONTEXT_MODE);
  const nodeOutput = await runOperation("whoami", {}, { source: "node", toolContext: withContext({ access_token: USER_TOKEN }) });
  assert.equal(nodeOutput.data.token, ENV_TOKEN);
  assert.ok(nodeOutput.data.envNames.includes("DEMO_TOKEN"));
  const overrideOutput = await runOperation("whoami", { access_token: "node-secret" }, { source: "node" });
  assert.equal(overrideOutput.data.token, "node-secret");
});

test("context mode scrubs the token (raw and URL-encoded) from error messages and keeps the kind", async () => {
  const failingDefinition = {
    ...pluginDefinition,
    operations: [{ ...echoOperation, run: async ({ client }) => { throw Object.assign(new Error(`echo ${client.token} ${encodeURIComponent(client.token)}`), { kind: "upstream", retryable: true }); } }],
  };
  const runOperation = createOperationRunner(failingDefinition, CONTEXT_MODE);
  await assert.rejects(runOperation("whoami", {}, { source: "tool", toolContext: withContext({ access_token: USER_TOKEN }) }), (error) => {
    assert.equal(error.message, "echo [redacted] [redacted]");
    assert.equal(error.kind, "upstream");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("an unknown source value refuses every tool call instead of using the env", async () => {
  const runOperation = createOperationRunner(pluginDefinition, { ...CONTEXT_MODE, DEMO_APP_TOOL_TOKEN_SOURCE: "contxt" });
  await assert.rejects(runOperation("whoami", {}, { source: "tool", toolContext: withContext({ access_token: USER_TOKEN }) }), /DEMO_APP_TOOL_TOKEN_SOURCE must be/);
});

test("resolveAccessToken gets the context token as nodeToken and the env without credentials", async () => {
  const seen = [];
  const definition = { ...pluginDefinition, resolveAccessToken: ({ environment, nodeToken }) => (seen.push({ nodeToken, hasEnvToken: "DEMO_TOKEN" in environment }), `resolved:${nodeToken}`) };
  const runOperation = createOperationRunner(definition, CONTEXT_MODE);
  await runOperation("whoami", {}, { source: "tool", toolContext: withContext({ access_token: USER_TOKEN }) });
  assert.deepEqual(seen, [{ nodeToken: USER_TOKEN, hasEnvToken: false }]);
});

function createFetchSpy(responseBody) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, fetchImpl };
}

test("declarative plugins: bearer and OAuth2 auth send the context token and hide the OAuth envs", async () => {
  const oauthSpec = {
    name: "demo-rest",
    version: "0.1.0",
    description: "Demo",
    baseUrl: "https://api.example.com",
    auth: { type: "oauth2", grant: "refresh_token", tokenUrl: "https://api.example.com/token", clientIdEnv: "DEMO_CLIENT_ID", clientSecretEnv: "DEMO_CLIENT_SECRET", refreshTokenEnv: "DEMO_REFRESH" },
    toolUserToken: true,
    operations: [{ name: "get_me", title: "Me", description: "Me", path: "/me" }],
  };
  const restDefinition = defineRestPlugin(oauthSpec);
  assert.deepEqual(restDefinition.toolUserToken.credentialEnv, ["DEMO_CLIENT_ID", "DEMO_CLIENT_SECRET", "DEMO_REFRESH"]);
  assert.ok(buildManifest(restDefinition).permissions.env.includes("DEMO_REST_TOOL_TOKEN_SOURCE"));
  const { requests, fetchImpl } = createFetchSpy({ id: 1, echoed: USER_TOKEN });
  const environment = { DEMO_REST_TOOL_TOKEN_SOURCE: "context", DEMO_CLIENT_ID: "id", DEMO_CLIENT_SECRET: "secret", DEMO_REFRESH: "refresh" };
  const runOperation = createOperationRunner(restDefinition, environment, { fetchImpl });
  const output = await runOperation("get_me", {}, { source: "tool", toolContext: withContext({ access_token: USER_TOKEN }) });
  assert.equal(requests.length, 1, "no token-endpoint request: the OAuth envs are not used");
  assert.equal(requests[0].headers.authorization, `Bearer ${USER_TOKEN}`);
  assert.ok(!JSON.stringify(output).includes(USER_TOKEN));

  await assert.rejects(runOperation("get_me", {}, { source: "tool" }), { kind: "auth_error" });
  assert.equal(requests.length, 1, "a refused call sends nothing");
});

test("defineRestPlugin rejects a malformed toolUserToken", () => {
  const baseSpec = { name: "demo-rest", version: "0.1.0", description: "Demo", baseUrl: "https://api.example.com", auth: { type: "bearer", env: "DEMO_TOKEN" }, operations: [{ name: "get_me", title: "Me", description: "Me", path: "/me" }] };
  assert.throws(() => defineRestPlugin({ ...baseSpec, toolUserToken: { credentialEnv: "DEMO" } }), /toolUserToken/);
  assert.throws(() => defineRestPlugin({ ...baseSpec, toolUserToken: { other: [] } }), /toolUserToken/);
  assert.throws(() => defineRestPlugin({ ...baseSpec, auth: { type: "none" }, toolUserToken: true }), /toolUserToken/);
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

test("over the protocol, the context token is used and never appears in the tool result or error", async () => {
  const replies = await talkToPlugin(pluginDefinition, CONTEXT_MODE, [
    { id: 1, method: "initialize", params: { protocol_version: 1, features: ["tool_context"] } },
    { id: 2, method: "tool.call", params: { request_id: "2", name: "whoami", arguments: {}, context: { secrets: { access_token: USER_TOKEN } } } },
    { id: 3, method: "tool.call", params: { request_id: "3", name: "whoami", arguments: { echo: "fail" }, context: { secrets: { access_token: USER_TOKEN } } } },
    { id: 4, method: "tool.call", params: { request_id: "4", name: "whoami", arguments: {} } },
  ]);
  const byId = Object.fromEntries(replies.map((reply) => [reply.id, reply]));
  assert.equal(byId[2].result.data.data.token, "[redacted]");
  assert.match(JSON.stringify(byId[3]), /bad token \[redacted\]/);
  assert.equal(byId[4].error.data.kind, "auth_error");
  for (const reply of replies) {
    assert.ok(!JSON.stringify(reply).includes(USER_TOKEN));
    assert.ok(!JSON.stringify(reply).includes(ENV_TOKEN));
  }
});
