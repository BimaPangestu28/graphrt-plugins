import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { authorizeTrello, API_KEY_ENV } from "../lib/trello-auth.mjs";
import { isTrelloReadPath } from "../lib/api-request-policy.mjs";
import { BOARD_ALLOWLIST_ENV } from "../lib/board-policy.mjs";
import { pluginDefinition } from "../definition.mjs";

const TOKEN = "trello-token-0001";
const KEY = "trello-key-0001";
const BOARD = "5f1b2c3d4e5f6a7b8c9d0e1f";
const environment = { TRELLO_TOKEN: TOKEN, [API_KEY_ENV]: KEY };

async function runOperation(operationName, args, responses, { source = "tool", extraEnvironment = {} } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const run = createOperationRunner(pluginDefinition, { ...environment, ...extraEnvironment }, { fetchImpl: recordingFetch });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: recordingFetch.calls };
}

test("authorizeTrello sets the documented OAuth header and returns both secrets", () => {
  const headers = {};
  const secrets = authorizeTrello({ headers, credential: TOKEN, environment });
  assert.equal(headers.authorization, `OAuth oauth_consumer_key="${KEY}", oauth_token="${TOKEN}"`);
  assert.ok(secrets.includes(KEY) && secrets.includes(TOKEN));
});

test("authorizeTrello needs TRELLO_API_KEY", () => {
  assert.throws(() => authorizeTrello({ headers: {}, credential: TOKEN, environment: {} }), (error) => error.kind === "auth_error" && error.message.includes(API_KEY_ENV));
});

test("authorizeTrello refuses quotes and line breaks in the key or token", () => {
  assert.throws(() => authorizeTrello({ headers: {}, credential: 'a"b', environment }), (error) => error.kind === "auth_error");
  assert.throws(() => authorizeTrello({ headers: {}, credential: TOKEN, environment: { [API_KEY_ENV]: "k\r\nx" } }), (error) => error.kind === "auth_error");
});

test("the API key is redacted from errors as well as the token", async () => {
  const { error } = await runOperation("get_me", {}, [{ status: 401, body: `invalid key ${KEY} token ${TOKEN}` }]);
  assert.equal(error.kind, "auth_error");
  assert.ok(!error.message.includes(KEY) && !error.message.includes(TOKEN), error.message);
});

test("isTrelloReadPath allows board, card and member reads and refuses token and webhook paths", () => {
  for (const allowedPath of ["/boards/abc/cards", "/cards/1/actions?filter=commentCard", "/members/me/boards", "/search", "/lists/1/cards", "/organizations/x/boards", "/members/me.json"]) {
    assert.equal(isTrelloReadPath(allowedPath), true, allowedPath);
  }
  for (const refusedPath of ["/members/me/tokens", "/tokens/abc", "/webhooks/1", "/tokens/abc/webhooks", "/members/me/../tokens", "/Members/ME/Tokens", "/applications/x", "/members/me/tokens.json", "/boards/1/%2E%2E/tokens"]) {
    assert.equal(isTrelloReadPath(refusedPath), false, refusedPath);
  }
});

test("api_request refuses the tokens and webhooks query keys for tools (in path or query)", async () => {
  for (const args of [{ path: "/members/me", query: { tokens: "all" } }, { path: "/members/me?tokens=all" }, { path: "/boards/abc", query: { Webhooks: "true" } }, { path: "/boards/abc?fields=name&webhooks=true" }]) {
    const refused = await runOperation("api_request", args, [{ body: {} }]);
    assert.equal(refused.error?.kind, "permission_denied", JSON.stringify(args));
    assert.equal(refused.calls.length, 0);
  }
  const allowed = await runOperation("api_request", { path: "/members/me", query: { fields: "username" } }, [{ body: {} }]);
  assert.equal(allowed.error, undefined);
});

test("exported pluginDefinition: tool api_request redacts the credential and refuses POST on an allowed path", async () => {
  const read = await runOperation("api_request", { path: "/members/me" }, [{ body: { echoed: `${TOKEN} ${KEY}` } }]);
  assert.equal(read.error, undefined);
  assert.ok(!JSON.stringify(read.output).includes(TOKEN) && !JSON.stringify(read.output).includes(KEY));
  const post = await runOperation("api_request", { path: "/cards", method: "POST", body: { name: "x" } }, [{ body: {} }]);
  assert.equal(post.error?.kind, "permission_denied");
  assert.equal(post.calls.length, 0);
});

test("api_request refuses token paths for tools but not for nodes", async () => {
  const refused = await runOperation("api_request", { path: "/members/me/tokens" }, [{ body: [] }]);
  assert.equal(refused.error.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const allowed = await runOperation("api_request", { path: "/members/me/tokens" }, [{ body: [] }], { source: "node" });
  assert.equal(allowed.error, undefined);
});

test("tool writes are refused when TRELLO_TOOL_BOARD_ALLOWLIST is unset, before any request", async () => {
  const { error, calls } = await runOperation("add_comment", { card_id: "c1", text: "hi" }, []);
  assert.equal(error.kind, "permission_denied");
  assert.match(error.message, new RegExp(BOARD_ALLOWLIST_ENV));
  assert.equal(calls.length, 0);
});

test("tool comment on a card of an allowed board looks up the board, then writes", async () => {
  const { output, calls } = await runOperation("add_comment", { card_id: "c1", text: "hi" }, [{ body: { id: "c1", idBoard: BOARD } }, { body: { id: "a1" } }], { extraEnvironment: { [BOARD_ALLOWLIST_ENV]: BOARD } });
  assert.deepEqual(output.data, { id: "a1" });
  assert.equal(new URL(calls[0].url).pathname, "/1/cards/c1");
  assert.equal(new URL(calls[0].url).searchParams.get("fields"), "idBoard");
  assert.equal(calls[1].method, "POST");
});

test("tool write to a card on another board is refused after the lookup", async () => {
  const { error, calls } = await runOperation("add_comment", { card_id: "c1", text: "hi" }, [{ body: { id: "c1", idBoard: "otherboard" } }], { extraEnvironment: { [BOARD_ALLOWLIST_ENV]: BOARD } });
  assert.equal(error.kind, "permission_denied");
  assert.equal(calls.length, 1);
});

test("create_card checks the list's board; update_card checks the destination list's board too", async () => {
  const allowEnvironment = { extraEnvironment: { [BOARD_ALLOWLIST_ENV]: BOARD } };
  const created = await runOperation("create_card", { list_id: "l1", name: "Ship" }, [{ body: { idBoard: BOARD } }, { body: { id: "card1" } }], allowEnvironment);
  assert.equal(new URL(created.calls[0].url).pathname, "/1/lists/l1");
  assert.deepEqual(created.output.data, { id: "card1" });
  const moved = await runOperation("update_card", { card_id: "c1", list_id: "l2" }, [{ body: { idBoard: BOARD } }, { body: { idBoard: "elsewhere" } }], allowEnvironment);
  assert.equal(moved.error.kind, "permission_denied");
  assert.equal(moved.calls.length, 2);
});

test("delete_card is node only, the API key env is permitted, and every write a tool can call is board-guarded", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.ok(manifest.permissions.env.includes(API_KEY_ENV) && manifest.permissions.env.includes(BOARD_ALLOWLIST_ENV));
  assert.equal(manifest.tools.some((tool) => tool.name === "delete_card"), false);
  const toolWrites = pluginDefinition.restSpec.operations.filter((operation) => operation.method !== "GET" && !operation.nodeOnly);
  const unguarded = toolWrites.filter((operation) => !pluginDefinition.operations.find((wrapped) => wrapped.name === operation.name).description.includes(BOARD_ALLOWLIST_ENV));
  assert.deepEqual(unguarded.map((operation) => operation.name), []);
});

test("a * allowlist allows any board without a lookup; nodes are never checked", async () => {
  const anyBoard = await runOperation("create_list", { board_id: "b9", name: "Doing" }, [{ body: { id: "list9" } }], { extraEnvironment: { [BOARD_ALLOWLIST_ENV]: "*" } });
  assert.equal(anyBoard.calls.length, 1);
  const node = await runOperation("add_checklist_item", { checklist_id: "k1", name: "Step" }, [{ body: { id: "i1" } }], { source: "node" });
  assert.equal(node.calls.length, 1);
});
