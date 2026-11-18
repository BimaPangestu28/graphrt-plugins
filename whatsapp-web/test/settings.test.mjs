import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolveSettings } from "../lib/settings.mjs";
import { installShutdownHandlers } from "../lib/shutdown.mjs";

test("settings defaults: profile under ~/.graphrt, 15 min idle, 30 s interval, 50 a day, no file dirs", () => {
  assert.deepEqual(resolveSettings({ HOME: "/Users/someone" }), {
    profileDirectory: "/Users/someone/.graphrt/whatsapp-web/profile",
    idleTimeoutMs: 900000,
    minSendIntervalMs: 30000,
    dailySendLimit: 50,
    allowedFileDirectories: [],
  });
});

test("settings read every variable and expand ~", () => {
  const settings = resolveSettings({
    HOME: "/Users/someone",
    WHATSAPP_WEB_PROFILE_DIR: "~/wa",
    WHATSAPP_WEB_IDLE_MINUTES: "2",
    WHATSAPP_WEB_MIN_SEND_INTERVAL_SECONDS: "10",
    WHATSAPP_WEB_DAILY_SEND_LIMIT: "5",
    WHATSAPP_WEB_ALLOWED_FILE_DIRS: "~/Outbox, /srv/share",
  });
  assert.deepEqual(settings, {
    profileDirectory: "/Users/someone/wa",
    idleTimeoutMs: 120000,
    minSendIntervalMs: 10000,
    dailySendLimit: 5,
    allowedFileDirectories: ["/Users/someone/Outbox", "/srv/share"],
  });
});

for (const [variableName, badValue] of [
  ["WHATSAPP_WEB_IDLE_MINUTES", "0"],
  ["WHATSAPP_WEB_MIN_SEND_INTERVAL_SECONDS", "-1"],
  ["WHATSAPP_WEB_DAILY_SEND_LIMIT", "2.5"],
  ["WHATSAPP_WEB_PROFILE_DIR", "relative/profile"],
]) {
  test(`settings reject ${variableName}=${badValue}`, () => {
    assert.throws(() => resolveSettings({ HOME: "/h", [variableName]: badValue }), { kind: "invalid_input" });
  });
}

test("shutdown closes the browsers once and exits, from a signal or the host", async () => {
  const fakeProcess = new EventEmitter();
  const events = [];
  const shutdown = installShutdownHandlers({
    closeAllClients: async () => events.push("close"),
    processObject: fakeProcess,
    exit: (exitCode) => events.push(`exit:${exitCode}`),
  });
  fakeProcess.emit("SIGTERM");
  await shutdown("host closed the connection");
  assert.deepEqual(events, ["close", "exit:0"]);
});

test("shutdown still exits when closing the browser fails", async () => {
  const events = [];
  const shutdown = installShutdownHandlers({
    closeAllClients: async () => {
      throw new Error("browser gone");
    },
    processObject: new EventEmitter(),
    exit: (exitCode) => events.push(`exit:${exitCode}`),
  });
  await shutdown("test");
  assert.deepEqual(events, ["exit:0"]);
});
