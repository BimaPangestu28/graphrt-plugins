import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginDefinition } from "../definition.mjs";
import { buildManifest } from "../lib/shared/operations.mjs";
import { BOT_PATH, okResponse, runWithResponses, runExpectingFailure } from "./helpers.mjs";

const INLINE_KEYBOARD = { inline_keyboard: [[{ text: "Yes", callback_data: "yes" }]] };

// Each case: operation + args → expected single request (HTTP method, Bot API method, query subset or exact JSON body).
const REQUEST_CASES = [
  ["get_updates", {}, { method: "GET", botMethod: "getUpdates", query: { limit: "100", timeout: "0" } }],
  [
    "get_updates",
    { cursor: "42", limit: 10, timeout: 25, allowed_updates: ["message", "callback_query"] },
    { method: "GET", botMethod: "getUpdates", query: { offset: "42", limit: "10", timeout: "25", allowed_updates: '["message","callback_query"]' } },
  ],
  ["get_updates", { offset: -1 }, { method: "GET", botMethod: "getUpdates", query: { offset: "-1" } }],
  ["send_message", { chat_id: "12345", text: "halo" }, { method: "POST", botMethod: "sendMessage", json: { chat_id: "12345", text: "halo" } }],
  [
    "send_message",
    {
      chat_id: -1001234567890,
      text: "*bold*",
      parse_mode: "MarkdownV2",
      reply_to_message_id: 7,
      disable_notification: true,
      reply_markup: INLINE_KEYBOARD,
      message_thread_id: 3,
      protect_content: true,
      disable_link_preview: true,
    },
    {
      method: "POST",
      botMethod: "sendMessage",
      json: {
        chat_id: "-1001234567890",
        text: "*bold*",
        parse_mode: "MarkdownV2",
        reply_parameters: { message_id: 7 },
        disable_notification: true,
        reply_markup: INLINE_KEYBOARD,
        message_thread_id: 3,
        protect_content: true,
        link_preview_options: { is_disabled: true },
      },
    },
  ],
  ["send_message", { chat_id: "@my_channel", text: "hi" }, { method: "POST", botMethod: "sendMessage", json: { chat_id: "@my_channel", text: "hi" } }],
  [
    "send_photo",
    { chat_id: "1", photo: "https://img.test/a.jpg", caption: "<b>pic</b>", parse_mode: "HTML", has_spoiler: true },
    { method: "POST", botMethod: "sendPhoto", json: { chat_id: "1", photo: "https://img.test/a.jpg", caption: "<b>pic</b>", parse_mode: "HTML", has_spoiler: true } },
  ],
  ["send_photo", { chat_id: "1", photo: "AgACAgIAAxkBAAIBY2Zf-abc_123" }, { method: "POST", botMethod: "sendPhoto", json: { chat_id: "1", photo: "AgACAgIAAxkBAAIBY2Zf-abc_123" } }],
  [
    "send_document",
    { chat_id: "1", document: "https://files.test/report.pdf", caption: "report", reply_to_message_id: 9 },
    { method: "POST", botMethod: "sendDocument", json: { chat_id: "1", document: "https://files.test/report.pdf", caption: "report", reply_parameters: { message_id: 9 } } },
  ],
  ["send_chat_action", { chat_id: "1", action: "typing" }, { method: "POST", botMethod: "sendChatAction", json: { chat_id: "1", action: "typing" } }],
  [
    "edit_message_text",
    { chat_id: "1", message_id: 5, text: "new", reply_markup: INLINE_KEYBOARD },
    { method: "POST", botMethod: "editMessageText", json: { chat_id: "1", message_id: 5, text: "new", reply_markup: INLINE_KEYBOARD } },
  ],
  ["edit_message_text", { inline_message_id: "AAA", text: "new" }, { method: "POST", botMethod: "editMessageText", json: { inline_message_id: "AAA", text: "new" } }],
  ["delete_message", { chat_id: "1", message_id: 5 }, { method: "POST", botMethod: "deleteMessage", json: { chat_id: "1", message_id: 5 } }],
  [
    "forward_message",
    { chat_id: "2", from_chat_id: "1", message_id: 5, disable_notification: true },
    { method: "POST", botMethod: "forwardMessage", json: { chat_id: "2", from_chat_id: "1", message_id: 5, disable_notification: true } },
  ],
  [
    "answer_callback_query",
    { callback_query_id: "cb1", text: "Saved", show_alert: true, cache_time: 5 },
    { method: "POST", botMethod: "answerCallbackQuery", json: { callback_query_id: "cb1", text: "Saved", show_alert: true, cache_time: 5 } },
  ],
  ["get_me", {}, { method: "GET", botMethod: "getMe" }],
  ["get_chat", { chat_id: "@my_channel" }, { method: "GET", botMethod: "getChat", query: { chat_id: "@my_channel" } }],
  ["get_chat_member_count", { chat_id: "-100123" }, { method: "GET", botMethod: "getChatMemberCount", query: { chat_id: "-100123" } }],
  ["get_webhook_info", {}, { method: "GET", botMethod: "getWebhookInfo" }],
  [
    "set_webhook",
    { url: "https://hooks.test/telegram", max_connections: 10, allowed_updates: ["message"], drop_pending_updates: true },
    { method: "POST", botMethod: "setWebhook", json: { url: "https://hooks.test/telegram", max_connections: 10, allowed_updates: ["message"], drop_pending_updates: true } },
  ],
  ["delete_webhook", { drop_pending_updates: true }, { method: "POST", botMethod: "deleteWebhook", json: { drop_pending_updates: true } }],
  ["api_request", { path: "/getMyCommands" }, { method: "GET", botMethod: "getMyCommands" }],
  [
    "api_request",
    { method: "POST", path: "/setMyCommands", body: { commands: [{ command: "start", description: "Start" }] } },
    { method: "POST", botMethod: "setMyCommands", json: { commands: [{ command: "start", description: "Start" }] } },
  ],
];

const NODE_ONLY_OPERATIONS = new Set(["set_webhook", "delete_webhook", "get_webhook_info"]);

for (const [operationName, args, expected] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expected.method} ${expected.botMethod}`, async () => {
    // Writes through api_request are workflow-only (agents may only call get* methods).
    const isApiWrite = operationName === "api_request" && expected.method !== "GET";
    const source = NODE_ONLY_OPERATIONS.has(operationName) || isApiWrite ? "node" : "tool";
    const { calls } = await runWithResponses(operationName, args, [okResponse([])], { source });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, expected.method);
    assert.equal(calls[0].path, `${BOT_PATH}/${expected.botMethod}`);
    assert.equal(calls[0].headers.authorization, undefined);
    for (const [queryName, queryValue] of Object.entries(expected.query ?? {})) assert.equal(calls[0].query[queryName], queryValue, queryName);
    if (expected.json) assert.deepEqual(calls[0].json, expected.json);
    if (expected.method === "GET") assert.equal(calls[0].body, undefined);
  });
}

test("operations return the Bot API `result`, not the envelope", async () => {
  const { output } = await runWithResponses("get_me", {}, [okResponse({ id: 1, is_bot: true, username: "demo_bot" })]);
  assert.deepEqual(output, { data: { id: 1, is_bot: true, username: "demo_bot" }, next_cursor: null });
});

test("get_updates returns next_cursor = last update_id + 1", async () => {
  const updates = [{ update_id: 100, message: { text: "a" } }, { update_id: 103, message: { text: "b" } }];
  const { output } = await runWithResponses("get_updates", { cursor: "100" }, [okResponse(updates)]);
  assert.deepEqual(output.data, updates);
  assert.equal(output.next_cursor, "104");
});

test("get_updates returns next_cursor null when there are no updates", async () => {
  const { output } = await runWithResponses("get_updates", { cursor: "104" }, [okResponse([])]);
  assert.equal(output.next_cursor, null);
});

test("get_updates gives the long poll its own timeout, longer than the poll", async () => {
  const seenSignals = [];
  const { createRecordingFetch } = await import("../lib/shared/testing.mjs");
  const recordingFetch = createRecordingFetch([okResponse([])]);
  const signalCapturingFetch = async (url, init) => {
    seenSignals.push(init.signal);
    return recordingFetch(url, init);
  };
  const { getUpdatesTimeoutMs } = await import("../operations/updates.mjs");
  assert.ok(getUpdatesTimeoutMs(25) > 25000);
  assert.ok(getUpdatesTimeoutMs(25) <= 40000);
  const { createOperationRunner } = await import("../lib/shared/operations.mjs");
  const { TEST_ENVIRONMENT } = await import("./helpers.mjs");
  await createOperationRunner(pluginDefinition, TEST_ENVIRONMENT, { fetchImpl: signalCapturingFetch })("get_updates", { timeout: 25 }, { source: "tool" });
  assert.equal(seenSignals.length, 1);
});

test("get_updates long poll fits inside the plugin's tool deadline", async () => {
  const { resolveToolDeadlineMs } = await import("../lib/shared/operations.mjs");
  const { getUpdatesTimeoutMs } = await import("../operations/updates.mjs");
  assert.ok(getUpdatesTimeoutMs(25) < resolveToolDeadlineMs(pluginDefinition));
});

const INVALID_INPUT_CASES = [
  ["get_updates", { timeout: 26 }],
  ["get_updates", { limit: 101 }],
  ["get_updates", { offset: 5, cursor: "6" }],
  ["get_updates", { cursor: "abc" }],
  ["send_message", { chat_id: "1", text: "x".repeat(4097) }],
  ["send_message", { chat_id: "not a chat", text: "hi" }],
  ["send_message", { chat_id: "@ab", text: "hi" }],
  ["send_message", { chat_id: "1", text: "hi", parse_mode: "BBCode" }],
  ["send_photo", { chat_id: "1", photo: "/Users/me/secret.png" }],
  ["send_photo", { chat_id: "1", photo: "./a.png" }],
  ["send_photo", { chat_id: "1", photo: "file:///etc/passwd" }],
  ["send_photo", { chat_id: "1", photo: "attach://photo" }],
  ["send_photo", { chat_id: "1", photo: "C:\\pics\\a.png" }],
  ["send_photo", { chat_id: "1", photo: "~/a.png" }],
  ["send_photo", { chat_id: "1", photo: "ftp://files.test/a.png" }],
  ["send_photo", { chat_id: "1", photo: "https://img.test/a.jpg", caption: "c".repeat(1025) }],
  ["send_document", { chat_id: "1", document: "report.pdf" }],
  ["send_chat_action", { chat_id: "1", action: "dancing" }],
  ["edit_message_text", { text: "new" }],
  ["edit_message_text", { chat_id: "1", text: "new" }],
  ["edit_message_text", { chat_id: "1", message_id: 5, inline_message_id: "AAA", text: "new" }],
  ["answer_callback_query", { callback_query_id: "cb1", text: "t".repeat(201) }],
  ["api_request", { path: "/bot123:abc/getMe" }],
  ["api_request", { path: "/getMe?x=1" }],
  ["api_request", { path: "/file/getMe" }],
  ["api_request", { path: "https://api.telegram.org/bot1:x/getMe" }],
  ["api_request", { path: "/setWebhook", method: "POST", body: { url: "https://evil.test" } }],
  ["api_request", { path: "/DELETEWEBHOOK", method: "POST" }],
  ["api_request", { path: "/logOut", method: "POST" }],
  ["api_request", { path: "/close", method: "POST" }],
  ["api_request", { path: "/getMe", method: "DELETE" }],
];

for (const [operationName, args] of INVALID_INPUT_CASES) {
  test(`${operationName} ${JSON.stringify(args).slice(0, 80)} is rejected as invalid_input before any request`, async () => {
    const { error, calls } = await runExpectingFailure(operationName, args, [okResponse()]);
    assert.equal(error.kind, "invalid_input", error.message);
    assert.equal(calls.length, 0);
  });
}

const SET_WEBHOOK_INVALID_CASES = [
  { url: "http://hooks.test/telegram" },
  { url: "https://hooks.test/telegram", max_connections: 101 },
];

for (const args of SET_WEBHOOK_INVALID_CASES) {
  test(`set_webhook ${JSON.stringify(args)} is rejected as invalid_input`, async () => {
    const { error, calls } = await runExpectingFailure("set_webhook", args, [okResponse()], { source: "node" });
    assert.equal(error.kind, "invalid_input", error.message);
    assert.equal(calls.length, 0);
  });
}

test("set_webhook sends TELEGRAM_WEBHOOK_SECRET as secret_token and rejects a malformed one", async () => {
  const environment = { TELEGRAM_BOT_TOKEN: "123456:TEST-secret_token-value", TELEGRAM_WEBHOOK_SECRET: "hook_Secret-1" };
  const { calls } = await runWithResponses("set_webhook", { url: "https://hooks.test/t" }, [okResponse()], { environment, source: "node" });
  assert.equal(calls[0].json.secret_token, "hook_Secret-1");
  const badEnvironment = { ...environment, TELEGRAM_WEBHOOK_SECRET: "has spaces!" };
  const { error } = await runExpectingFailure("set_webhook", { url: "https://hooks.test/t" }, [okResponse()], { environment: badEnvironment, source: "node" });
  assert.equal(error.kind, "invalid_input");
  assert.doesNotMatch(error.message, /has spaces/);
});

test("webhook operations are node-only: not tools, and refused when called as a tool", async () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  for (const operationName of NODE_ONLY_OPERATIONS) {
    assert.ok(!toolNames.includes(operationName), operationName);
    assert.ok(manifest.nodes.some((node) => node.kind === `telegram-bot.${operationName}`), operationName);
    const { error, calls } = await runExpectingFailure(operationName, { url: "https://hooks.test/t" }, [okResponse()]);
    assert.equal(error.kind, "invalid_input");
    assert.equal(calls.length, 0);
  }
});

test("manifest asks for network, secrets and the Telegram env vars only", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: true, secrets: true, env: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] });
});

// --- review fixes ---
test("dedicated operations redact the token from responses (e.g. a webhook URL containing it)", async () => {
  const { TEST_ENVIRONMENT: environment, okResponse: ok, runWithResponses: run } = await import("./helpers.mjs");
  const token = environment.TELEGRAM_BOT_TOKEN;
  const { output } = await run("get_webhook_info", {}, [ok({ url: `https://h/bot${token}`, last_error_message: `bad ${token}` })], { source: "node" });
  assert.equal(JSON.stringify(output).includes(token), false);
});

test("api_request refuses getUpdates, which would drop the workflow's unread updates", async () => {
  const { runWithResponses: run } = await import("./helpers.mjs");
  await assert.rejects(run("api_request", { path: "/getUpdates", query: { offset: -1 } }, []), (error) => error.kind === "invalid_input" && /get_updates/.test(error.message));
});

test("api_request as an agent tool may only call get* methods, even with GET", async () => {
  const { runWithResponses: run, okResponse: ok } = await import("./helpers.mjs");
  await assert.rejects(run("api_request", { method: "GET", path: "/sendMessage", query: { chat_id: 1, text: "x" } }, []), (error) => error.kind === "permission_denied");
  await assert.rejects(run("api_request", { method: "POST", path: "/transferBusinessAccountStars", body: { star_count: 1000 } }, []), (error) => error.kind === "permission_denied");
  const { calls } = await run("api_request", { method: "GET", path: "/getMyCommands" }, [ok([])]);
  assert.equal(calls.length, 1);
  const nodeRun = await run("api_request", { method: "POST", path: "/setMyCommands", body: { commands: [] } }, [ok(true)], { source: "node" });
  assert.equal(nodeRun.calls.length, 1);
});

test("an env token with surrounding whitespace is trimmed, and its URL-encoded form is redacted", async () => {
  const { TEST_ENVIRONMENT: environment, runWithResponses: run } = await import("./helpers.mjs");
  const token = environment.TELEGRAM_BOT_TOKEN;
  const echoingFetchEnvironment = { ...environment, TELEGRAM_BOT_TOKEN: `  ${token}\n` };
  await assert.rejects(
    run("get_me", {}, [{ status: 400, body: { ok: false, error_code: 400, description: `seen ${encodeURIComponent(token)}` } }], { environment: echoingFetchEnvironment }),
    (error) => !error.message.includes(encodeURIComponent(token)) && !error.message.includes(token) && !/malformed/.test(error.message),
  );
});

test("chat ids from templates are trimmed, and absurd cursors are rejected", async () => {
  const { runWithResponses: run, okResponse: ok } = await import("./helpers.mjs");
  const { calls } = await run("get_chat", { chat_id: " 12345\n" }, [ok({ id: 12345 })]);
  assert.equal(calls[0].query.chat_id ?? calls[0].json?.chat_id, "12345");
  await assert.rejects(run("get_updates", { cursor: "99999999999999999999" }, []), (error) => error.kind === "invalid_input");
});
