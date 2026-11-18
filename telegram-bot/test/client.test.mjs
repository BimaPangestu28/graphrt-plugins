import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTelegramError, detectTelegramBodyError, createTelegramClient } from "../lib/client.mjs";
import { TEST_TOKEN, TEST_ENVIRONMENT, okResponse, runWithResponses, runExpectingFailure } from "./helpers.mjs";

const noHeaders = new Headers();
const failure = (errorCode, description, parameters) => ({ ok: false, error_code: errorCode, description, ...(parameters ? { parameters } : {}) });

for (const [status, description, expectedKind] of [
  [401, "Unauthorized", "auth_error"],
  [403, "Forbidden: bot was blocked by the user", "permission_denied"],
  [403, "Forbidden: bot is not a member of the channel chat", "permission_denied"],
  [400, "Bad Request: chat not found", "not_found"],
  [400, "Bad Request: message to edit not found", "not_found"],
  [400, "Bad Request: message text is empty", "invalid_input"],
  [400, "Bad Request: message is not modified", "invalid_input"],
  [404, "Not Found", "not_found"],
  [429, "Too Many Requests: retry after 5", "rate_limited"],
  [500, "Internal Server Error", "api_error"],
]) {
  test(`parseTelegramError maps ${status} "${description}" to ${expectedKind}`, () => {
    const parsed = parseTelegramError(status, failure(status, description), noHeaders);
    assert.equal(parsed.kind, expectedKind);
    assert.match(parsed.message, new RegExp(description.split(":")[0]));
  });
}

test("parseTelegramError reads parameters.retry_after into retryAfterMs", () => {
  const parsed = parseTelegramError(429, failure(429, "Too Many Requests: retry after 7", { retry_after: 7 }), noHeaders);
  assert.equal(parsed.kind, "rate_limited");
  assert.equal(parsed.retryAfterMs, 7000);
});

test("parseTelegramError reports a group migrated to a supergroup with the new chat id, not retryable", () => {
  const parsed = parseTelegramError(400, failure(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: -1009876 }), noHeaders);
  assert.equal(parsed.kind, "invalid_input");
  assert.equal(parsed.retryable, false);
  assert.match(parsed.message, /-1009876/);
});

test("parseTelegramError explains 409 conflicts (webhook set or another getUpdates) and does not retry", () => {
  const parsed = parseTelegramError(409, failure(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"), noHeaders);
  assert.equal(parsed.kind, "api_error");
  assert.equal(parsed.retryable, false);
  assert.match(parsed.message, /delete_webhook|one/);
});

test("parseTelegramError leaves non-Telegram bodies to the default mapping", () => {
  assert.deepEqual(parseTelegramError(502, { text: "Bad gateway" }, noHeaders), {});
});

test("detectTelegramBodyError flags ok:false inside a 2xx body", () => {
  assert.equal(detectTelegramBodyError({ ok: true, result: 1 }), null);
  assert.equal(detectTelegramBodyError(failure(403, "Forbidden: bot was blocked by the user")).kind, "permission_denied");
});

test("createTelegramClient rejects a malformed token without echoing it", () => {
  for (const badToken of ["no-colon", "123:abc/../getMe", "123:abc?x=1", "abc:def", "123:abc def"]) {
    assert.throws(
      () => createTelegramClient({ accessToken: badToken, environment: {} }),
      (error) => error.kind === "auth_error" && !error.message.includes(badToken),
      badToken,
    );
  }
});

test("a missing TELEGRAM_BOT_TOKEN is an auth_error", async () => {
  const { error } = await runExpectingFailure("get_me", {}, [okResponse()], { environment: {} });
  assert.equal(error.kind, "auth_error");
  assert.match(error.message, /TELEGRAM_BOT_TOKEN/);
});

test("401 from Telegram becomes auth_error and the error never contains the token", async () => {
  const { error, calls } = await runExpectingFailure("get_me", {}, [{ status: 401, body: failure(401, "Unauthorized") }]);
  assert.equal(error.kind, "auth_error");
  assert.equal(calls.length, 1);
  assert.ok(!error.message.includes(TEST_TOKEN));
  assert.ok(!error.message.includes(TEST_TOKEN.split(":")[1]));
});

test("an error description that echoes the token is redacted", async () => {
  const { error } = await runExpectingFailure("get_me", {}, [{ status: 400, body: failure(400, `Bad Request: bad url /bot${TEST_TOKEN}/getMe`) }]);
  assert.ok(!error.message.includes(TEST_TOKEN), error.message);
  assert.match(error.message, /\[redacted\]/);
});

test("a network error whose text contains the request URL is redacted", async () => {
  const throwingFetch = async (url) => {
    throw new TypeError(`fetch failed for ${url}`);
  };
  const { error } = await runExpectingFailure("get_me", {}, throwingFetch);
  assert.equal(error.kind, "network_error");
  assert.ok(!error.message.includes(TEST_TOKEN), error.message);
});

test("api_request redacts the token from the response body", async () => {
  const echoed = { ok: true, result: { note: `see https://api.telegram.org/bot${TEST_TOKEN}/getMe`, nested: [TEST_TOKEN] } };
  const { output } = await runWithResponses("api_request", { path: "/getMe" }, [{ body: echoed }]);
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes(TEST_TOKEN), serialized);
  assert.match(serialized, /\[redacted\]/);
});

test("the webhook secret is redacted from errors too", async () => {
  const environment = { ...TEST_ENVIRONMENT, TELEGRAM_WEBHOOK_SECRET: "hook_secret_value" };
  const { error } = await runExpectingFailure("set_webhook", { url: "https://hooks.test/t" }, [{ status: 400, body: failure(400, "Bad Request: secret hook_secret_value rejected") }], {
    environment,
    source: "node",
  });
  assert.ok(!error.message.includes("hook_secret_value"), error.message);
});

test("sends are never retried after a 5xx (unknown outcome)", async () => {
  const { error, calls } = await runExpectingFailure("send_message", { chat_id: "1", text: "hi" }, [
    { status: 502, body: { text: "Bad gateway" } },
    okResponse({ message_id: 1 }),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(error.retryable, false);
  assert.match(error.message, /outcome unknown/);
});

test("sends are never retried after a network error", async () => {
  let attempts = 0;
  const failingFetch = async () => {
    attempts += 1;
    throw new TypeError("fetch failed");
  };
  const { error } = await runExpectingFailure("send_message", { chat_id: "1", text: "hi" }, failingFetch);
  assert.equal(attempts, 1);
  assert.equal(error.kind, "network_error");
  assert.equal(error.retryable, false);
});

test("a 429 with retry_after is retried after the wait, even for sends", async () => {
  const { output, calls } = await runWithResponses("send_message", { chat_id: "1", text: "hi" }, [
    { status: 429, body: failure(429, "Too Many Requests: retry after 0", { retry_after: 0 }) },
    okResponse({ message_id: 9 }),
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(output.data, { message_id: 9 });
});

test("reads are retried after a 5xx", async () => {
  const { output, calls } = await runWithResponses("get_me", {}, [{ status: 502, body: { text: "Bad gateway" } }, okResponse({ id: 1 })]);
  assert.equal(calls.length, 2);
  assert.deepEqual(output.data, { id: 1 });
});
