import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DENIED_COMMANDS } from "../operations/command.mjs";
import { clampRange } from "../operations/common.mjs";
import { classifyRedisError } from "../lib/errors.mjs";
import { createKeyspace, escapeGlob } from "../lib/keyspace.mjs";
import { buildUrlSecrets, createRedactor } from "../lib/redaction.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { installShutdownHandlers } from "../lib/shutdown.mjs";
import { decodeReply, decodeValue, encodeValue } from "../lib/values.mjs";
import { createTestRunner } from "./helpers.mjs";

// Stand-in for the ioredis command table: SET/HINCRBY/SORT keys as the real table reports them.
const KEY_TABLE = { set: [0], hincrby: [0], sort: [0, 2], zscore: [0], ping: [] };
const loadFinder = async () => (commandName) => KEY_TABLE[commandName] ?? null;

test("command runs a node-only command with argument arrays and decodes the reply", async () => {
  const { runOperation, state } = createTestRunner({ loadFinder, responders: { hincrby: () => 6 } });
  const output = await runOperation("command", { command: "HINCRBY", args: ["stats", "views", 1] });
  assert.deepEqual(state.commands[0], ["hincrby", "stats", "views", "1"]);
  assert.deepEqual(output.data, { command: "HINCRBY", reply: 6 });
});

test("command is not available to tools at all", async () => {
  const { runOperation } = createTestRunner({ loadFinder, environment: { REDIS_TOOL_ALLOW_WRITES: "1" } });
  await assert.rejects(runOperation("command", { command: "PING" }, { source: "tool" }), { kind: "invalid_input", message: /Unknown operation/ });
});

for (const commandName of ["FLUSHALL", "flushdb", "CONFIG", "SHUTDOWN", "DEBUG", "SCRIPT", "EVAL", "EVALSHA", "FUNCTION", "KEYS", "SELECT", "MULTI", "SUBSCRIBE", "BLPOP", "CLIENT", "MONITOR"]) {
  test(`command refuses ${commandName}`, async () => {
    const { runOperation, state } = createTestRunner({ loadFinder });
    await assert.rejects(runOperation("command", { command: commandName, args: ["x"] }), { kind: "permission_denied" });
    assert.equal(state.commands.length, 0);
  });
}

test("command refuses XREAD/XREADGROUP with BLOCK and names with spaces", async () => {
  const { runOperation } = createTestRunner({ loadFinder });
  await assert.rejects(runOperation("command", { command: "XREAD", args: ["BLOCK", "0", "STREAMS", "s", "$"] }), { kind: "permission_denied" });
  await assert.rejects(runOperation("command", { command: "GET k" }), { kind: "invalid_input" });
  await assert.rejects(runOperation("command", { command: "GET", args: [{ nested: true }] }), { kind: "invalid_input" });
});

test("command with REDIS_KEY_PREFIX prefixes key positions (including SORT BY patterns)", async () => {
  const { runOperation, state } = createTestRunner({ loadFinder, environment: { REDIS_KEY_PREFIX: "t:" }, responders: { sort: () => [], ping: () => "PONG" } });
  await runOperation("command", { command: "SORT", args: ["ids", "BY", "weight_*", "LIMIT", "0", "10"] });
  assert.deepEqual(state.commands[0], ["sort", "t:ids", "BY", "t:weight_*", "LIMIT", "0", "10"]);
  await runOperation("command", { command: "PING" });
});

test("command with REDIS_KEY_PREFIX refuses unknown and keyspace-wide commands", async () => {
  const { runOperation } = createTestRunner({ loadFinder, environment: { REDIS_KEY_PREFIX: "t:" } });
  await assert.rejects(runOperation("command", { command: "MYMODULE.CMD", args: ["k"] }), { kind: "permission_denied", message: /key table/ });
  for (const commandName of ["SCAN", "RANDOMKEY", "DBSIZE", "PUBLISH"]) {
    await assert.rejects(runOperation("command", { command: commandName, args: ["0"] }), { kind: "permission_denied" });
  }
});

test("denylist covers the commands the plugin promises to refuse", () => {
  for (const commandName of ["flushall", "flushdb", "config", "shutdown", "debug", "script", "eval", "evalsha", "keys", "function", "fcall"]) {
    assert.ok(DENIED_COMMANDS.has(commandName), commandName);
  }
});

test("keyspace: prefixing, stripping and glob escaping", () => {
  const keyspace = createKeyspace("a*b:");
  assert.equal(keyspace.toServerKey("k"), "a*b:k");
  assert.equal(keyspace.scanPattern("x?"), "a\\*b:x?");
  assert.equal(keyspace.fromServerKey(Buffer.from("a*b:k")).toString(), "k");
  assert.equal(keyspace.fromServerKey(Buffer.from("other:k")), null);
  assert.equal(escapeGlob("[a]\\"), "\\[a\\]\\\\");
  assert.throws(() => keyspace.toServerKey(""), { kind: "invalid_input" });
  assert.throws(() => keyspace.toServerKey("x".repeat(5000)), { kind: "invalid_input" });
});

test("values: strict base64, size caps, lossless decoding", () => {
  assert.deepEqual(encodeValue("aGk=", { encoding: "base64", label: "v", maxBytes: 10 }), Buffer.from("hi"));
  assert.throws(() => encodeValue("aGk", { encoding: "base64", label: "v", maxBytes: 10 }), { kind: "invalid_input" });
  assert.throws(() => encodeValue("héllo", { encoding: "utf8", label: "v", maxBytes: 5 }), { kind: "invalid_input" });
  assert.deepEqual(encodeValue(42, { label: "v", maxBytes: 10 }), Buffer.from("42"));
  assert.equal(decodeValue(Buffer.from("héllo")), "héllo");
  assert.deepEqual(decodeValue(Buffer.from([0xc3])), { base64: "ww==" });
  assert.deepEqual(decodeReply([Buffer.from("a"), 1, null, [Buffer.from([0xff])]]), ["a", 1, null, [{ base64: "/w==" }]]);
  assert.deepEqual(decodeReply({ name: Buffer.from("Budi") }), { name: "Budi" }, "ioredis HGETALL objects");
});

test("clampRange", () => {
  assert.deepEqual(clampRange(0, -1, 10), { start: 0, stop: 9, truncated: false, empty: false });
  assert.deepEqual(clampRange(-3, -1, 10), { start: 7, stop: 9, truncated: false, empty: false });
  assert.deepEqual(clampRange(5, 2, 10).empty, true);
  assert.deepEqual(clampRange(0, -1, 0).empty, true);
  assert.deepEqual(clampRange(10, 5000, 3000), { start: 10, stop: 1009, truncated: true, empty: false });
});

test("settings: defaults and validation", () => {
  const settings = resolveSettings({}, "rediss://h:6380");
  assert.deepEqual(settings, {
    connectionUrl: "rediss://h:6380",
    keyPrefix: "",
    toolWritesAllowed: false,
    maxValueBytes: 1048576,
    maxResultBytes: 4194304,
    commandTimeoutMs: 10000,
    idleTimeoutMs: 300000,
  });
  assert.throws(() => resolveSettings({ REDIS_KEY_PREFIX: "a b" }, "redis://h"), { kind: "invalid_input" });
  assert.throws(() => resolveSettings({ REDIS_COMMAND_TIMEOUT_MS: "5" }, "redis://h"), { kind: "invalid_input" });
  assert.throws(() => resolveSettings({}, "unix:///tmp/redis.sock"), { kind: "invalid_input" });
});

test("redactor hides the password of redis://:password@ and user:password URLs", () => {
  const redact = createRedactor(buildUrlSecrets("redis://:p%40ss-word@cache:6379"));
  assert.equal(redact("AUTH p@ss-word failed"), "AUTH [redacted] failed");
  assert.equal(redact("rediss://bob:other-secret@h"), "rediss://bob:[redacted]@h");
});

test("error classification", () => {
  assert.equal(classifyRedisError(Object.assign(new Error("NOPERM no permission"), { name: "ReplyError" })).kind, "permission_denied");
  assert.equal(classifyRedisError(Object.assign(new Error("LOADING dataset"), { name: "ReplyError" })).retryable, true);
  assert.equal(classifyRedisError(new Error("Connection is closed.")).kind, "network_error");
  assert.equal(classifyRedisError(Object.assign(new Error("ERR syntax error"), { name: "ReplyError" })).kind, "invalid_input");
});

test("shutdown drains, closes once and exits", async () => {
  const events = [];
  const shutdown = installShutdownHandlers({
    pluginName: "redis",
    closeAllClients: async () => events.push("close"),
    waitForRunningOperations: async () => events.push("wait") && "idle",
    processObject: new EventEmitter(),
    exit: () => events.push("exit"),
  });
  await Promise.all([shutdown("stdin", { letRunningFinish: true }), shutdown("signal")]);
  assert.deepEqual(events, ["wait", "close", "exit"]);
});
