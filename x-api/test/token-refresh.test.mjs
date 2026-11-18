import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses, rejectsWithKind } from "./helpers.mjs";

const TOKEN_RESPONSE = { body: { token_type: "bearer", expires_in: 7200, access_token: "new-access", refresh_token: "new-refresh", scope: "tweet.read" } };
const REFRESH_ARGS = { refresh_token: "old-refresh", client_id: "client-123" };

test("refresh_access_token posts the refresh grant without the Bearer token (public client)", async () => {
  const { output, calls } = await runWithResponses("refresh_access_token", REFRESH_ARGS, [TOKEN_RESPONSE]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.x.com/2/oauth2/token");
  assert.equal(call.headers.authorization, undefined);
  assert.deepEqual(call.form, { grant_type: "refresh_token", refresh_token: "old-refresh", client_id: "client-123" });
  assert.deepEqual(output.data, TOKEN_RESPONSE.body);
});

test("refresh_access_token uses Basic auth when X_CLIENT_SECRET is set", async () => {
  const environment = { X_ACCESS_TOKEN: "user-token", X_CLIENT_SECRET: "secret-xyz" };
  const { calls } = await runWithResponses("refresh_access_token", REFRESH_ARGS, [TOKEN_RESPONSE], environment);
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("client-123:secret-xyz").toString("base64")}`);
});

test("refresh_access_token works without X_ACCESS_TOKEN", async () => {
  const { output } = await runWithResponses("refresh_access_token", REFRESH_ARGS, [TOKEN_RESPONSE], {});
  assert.equal(output.data.access_token, "new-access");
});

test("refresh_access_token maps OAuth errors to auth_error without leaking the refresh token", async () => {
  const errorResponse = { status: 400, body: { error: "invalid_request", error_description: "Value passed for the token was invalid: old-refresh" } };
  await assert.rejects(
    runWithResponses("refresh_access_token", REFRESH_ARGS, [errorResponse]),
    (error) => error.kind === "auth_error" && !error.message.includes("old-refresh") && /invalid/.test(error.message),
  );
});

test("refresh_access_token fails when the response has no access token", async () => {
  await rejectsWithKind(assert, runWithResponses("refresh_access_token", REFRESH_ARGS, [{ body: {} }]), "api_error", /access_token/);
});

test("refresh_access_token falls back to X_REFRESH_TOKEN and X_CLIENT_ID from env", async () => {
  const environment = { X_REFRESH_TOKEN: "env-refresh", X_CLIENT_ID: "env-client" };
  const { calls } = await runWithResponses("refresh_access_token", {}, [TOKEN_RESPONSE], environment);
  assert.equal(calls[0].form.refresh_token, "env-refresh");
  assert.equal(calls[0].form.client_id, "env-client");
});

test("refresh_access_token without any refresh token fails with invalid_input", async () => {
  await assert.rejects(runWithResponses("refresh_access_token", {}, [], {}), (error) => error.kind === "invalid_input");
});

test("refresh_access_token is a node but not an LLM tool", async () => {
  const { buildDescriptors } = await import("../lib/shared/operations.mjs");
  const { pluginDefinition } = await import("../definition.mjs");
  const { nodes, tools } = buildDescriptors(pluginDefinition);
  assert.ok(nodes.some((node) => node.kind === "x-api.refresh_access_token"));
  assert.equal(tools.some((tool) => tool.name === "refresh_access_token"), false);
});
