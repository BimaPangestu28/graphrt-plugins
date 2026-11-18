import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { SEND_STATE_FILE_NAME, createClientFactory } from "../lib/client.mjs";
import { pluginDefinition } from "../definition.mjs";
import { LOGIN_SETTLE_MS } from "../lib/whatsapp-page.mjs";
import { createFakeDriver, createTestRunner } from "./helpers.mjs";

async function withRunner(runnerOptions, testBody) {
  const runner = await createTestRunner(runnerOptions);
  try {
    await testBody(runner);
  } finally {
    await runner.cleanup();
  }
}

test("manifest: login is a node only, every other operation is also a tool, one at a time", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["get_status", "list_chats", "search_chats", "read_messages", "send_message", "send_file"]);
  assert.ok(manifest.nodes.some((node) => node.kind === "whatsapp-web.login"));
  assert.equal(manifest.limits.max_concurrency, 1);
  assert.ok(manifest.permissions.env.includes("WHATSAPP_WEB_PROFILE_DIR"));
  assert.ok(manifest.permissions.env.includes("WHATSAPP_WEB_DAILY_SEND_LIMIT"));
});

test("login timeout_seconds is capped so page load + scan + settle stay under the manifest timeout", () => {
  const loginOperation = pluginDefinition.operations.find((operation) => operation.name === "login");
  const maximumSeconds = loginOperation.parameters.properties.timeout_seconds.maximum;
  // timeout_seconds covers loading WhatsApp Web and the scan; the settle and starting the browser come on top.
  const browserStartAndPollingMarginMs = 45000;
  assert.ok(maximumSeconds * 1000 + LOGIN_SETTLE_MS + browserStartAndPollingMarginMs <= pluginDefinition.limits.timeout_ms, `maximum ${maximumSeconds} s is too long`);
});

test("login cannot be called as a tool", () =>
  withRunner({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("login", {}, "tool"), { kind: "invalid_input" });
  }));

// Each case: operation + args → expected driver method and the options it receives (subset).
const DRIVER_CASES = [
  ["login", { timeout_seconds: 60 }, "node", "login", { timeoutMs: 60000 }],
  ["get_status", {}, "tool", "getStatus", {}],
  ["list_chats", {}, "tool", "listChats", { limit: 20, unreadOnly: false }],
  ["list_chats", { limit: "5", unread_only: "true" }, "tool", "listChats", { limit: 5, unreadOnly: true }],
  ["search_chats", { query: "kantor" }, "tool", "searchChats", { query: "kantor", limit: 20 }],
  ["read_messages", { phone: "+62 812-3456-789", limit: 3 }, "tool", "readMessages", { target: { phone: "628123456789" }, limit: 3 }],
  ["read_messages", { chat_name: " Ibu " }, "tool", "readMessages", { target: { name: "Ibu" }, limit: 20 }],
  ["send_message", { chat_name: "Ibu", text: "halo" }, "tool", "sendText", { target: { name: "Ibu" }, text: "halo" }],
  ["send_message", { phone: "+628123456789", text: "a\nb" }, "node", "sendText", { target: { phone: "628123456789" }, text: "a\nb" }],
  ["send_message", { phone: "0062 812 3456 789", text: "hi" }, "tool", "sendText", { target: { phone: "628123456789" }, text: "hi" }],
];

for (const [operationName, args, source, driverMethod, expectedOptions] of DRIVER_CASES) {
  test(`${operationName} ${JSON.stringify(args)} calls driver.${driverMethod}`, () =>
    withRunner({}, async ({ runOperation, driver }) => {
      await runOperation(operationName, args, source);
      assert.equal(driver.calls.length, 1);
      const [calledMethod, calledOptions] = driver.calls[0];
      assert.equal(calledMethod, driverMethod);
      for (const [key, expectedValue] of Object.entries(expectedOptions)) assert.deepEqual(calledOptions[key], expectedValue, key);
      assert.ok(calledOptions.signal instanceof AbortSignal, "every driver call gets a signal (deadline for tools)");
    }));
}

const INVALID_INPUT_CASES = [
  ["read_messages", {}],
  ["read_messages", { phone: "0812345", chat_name: "Ibu" }],
  ["read_messages", { phone: "12" }],
  ["send_message", { phone: "08123456789", text: "hi" }],
  ["send_message", { phone: "628123456789", text: "hi" }],
  ["send_message", { chat_name: "Ibu" }],
  ["send_message", { chat_name: "Ibu", text: "" }],
  ["send_message", { chat_name: "Ibu", text: "x".repeat(65537) }],
  ["send_file", { chat_name: "Ibu", file: "relative/path.png" }],
  ["send_file", { chat_name: "Ibu", file: "http://example.com/a.png" }],
  ["send_file", { chat_name: "Ibu", file: "/etc/hosts" }],
  ["search_chats", {}],
  ["list_chats", { limit: 0 }],
];
for (const [operationName, args] of INVALID_INPUT_CASES) {
  test(`${operationName} ${JSON.stringify(args).slice(0, 60)} is invalid_input and sends nothing`, () =>
    withRunner({}, async ({ runOperation, driver }) => {
      await assert.rejects(runOperation(operationName, args), { kind: "invalid_input" });
      assert.equal(driver.calls.length, 0);
    }));
}

test("get_status reports the login state and today's usage", () =>
  withRunner({ driverOverrides: { getStatus: async () => "needs_login" } }, async ({ runOperation, profileDirectory }) => {
    const { data } = await runOperation("get_status", {});
    assert.equal(data.status, "needs_login");
    assert.match(data.hint, /login node/);
    assert.equal(data.profile_directory, profileDirectory);
    assert.equal(data.sends_today, 0);
    assert.equal(data.daily_limit, 50);
  }));

test("send_message shapes the result and counts the send in the profile directory", () =>
  withRunner({}, async ({ runOperation, profileDirectory }) => {
    const { data, next_cursor } = await runOperation("send_message", { chat_name: "Ibu", text: "halo" });
    assert.equal(next_cursor, null);
    assert.deepEqual(data, {
      sent: true,
      chat_name: "Ibu",
      phone: null,
      message_id: "3EB0NEW",
      status: "sent",
      time: "10:42, 18/11/2026",
      sends_today: 1,
      daily_limit: 50,
    });
    const savedState = JSON.parse(await readFile(join(profileDirectory, SEND_STATE_FILE_NAME), "utf8"));
    assert.equal(savedState.count, 1);
  }));

test("the daily cap stops a send before the message is typed", () =>
  withRunner({ environment: { WHATSAPP_WEB_DAILY_SEND_LIMIT: "1" } }, async ({ runOperation, driver }) => {
    await runOperation("send_message", { chat_name: "Ibu", text: "one" });
    await assert.rejects(runOperation("send_message", { chat_name: "Ibu", text: "two" }), { kind: "rate_limited" });
    assert.equal(driver.calls.length, 2, "the driver ran beforeSend, which threw before sendText could type");
  }));

test("a failed send is not retried", () =>
  withRunner(
    {
      driverOverrides: {
        sendText: async (options) => {
          await options.beforeSend();
          throw Object.assign(new Error("WhatsApp Web step `confirm sent` failed"), { kind: "browser_error" });
        },
      },
    },
    async ({ runOperation, driver }) => {
      await assert.rejects(runOperation("send_message", { chat_name: "Ibu", text: "x" }), { kind: "browser_error" });
      assert.equal(driver.calls.length, 1);
    },
  ));

test("invalid settings are reported as invalid_input", () =>
  withRunner({ environment: { WHATSAPP_WEB_DAILY_SEND_LIMIT: "lots" } }, async ({ runOperation }) => {
    await assert.rejects(runOperation("get_status", {}), (error) => error.kind === "invalid_input" && /WHATSAPP_WEB_DAILY_SEND_LIMIT/.test(error.message));
  }));

test("driver errors pass through unchanged (auth_error, not_found)", () =>
  withRunner(
    {
      driverOverrides: {
        listChats: async () => {
          throw Object.assign(new Error("not logged in"), { kind: "auth_error" });
        },
      },
    },
    async ({ runOperation }) => {
      await assert.rejects(runOperation("list_chats", {}), { kind: "auth_error" });
    },
  ));

test("one driver (one browser session) per profile is reused across operations and closed on shutdown", async () => {
  const createdDrivers = [];
  const factory = createClientFactory({
    createDriver: () => {
      const driver = createFakeDriver();
      createdDrivers.push(driver);
      return driver;
    },
  });
  const environment = { WHATSAPP_WEB_PROFILE_DIR: "/tmp/wa-profile-a" };
  assert.equal(factory.createClient({ environment }), factory.createClient({ environment }));
  factory.createClient({ environment: { WHATSAPP_WEB_PROFILE_DIR: "/tmp/wa-profile-b" } });
  assert.equal(createdDrivers.length, 2);
  await factory.closeAllClients();
  assert.deepEqual(createdDrivers.map((driver) => driver.calls.map(([methodName]) => methodName)), [["close"], ["close"]]);
});
