/**
 * Review follow-ups: lossless xreadgroup under the size cap, mget caps and
 * errors, prefix-escaping commands, scan pages, binary key and field names,
 * HSTRLEN before HGET, and `password=` redaction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrlSecrets, createRedactor } from "../lib/redaction.mjs";
import { createTestRunner, replyError } from "./helpers.mjs";

const AS_TOOL = { source: "tool" };
const bulk = (...texts) => texts.map((text) => (Buffer.isBuffer(text) ? text : Buffer.from(String(text))));
const KEY_TABLE = { copy: [0, 1], slowlog: [], info: [], latency: [], get: [0] };
const loadFinder = async () => (commandName) => KEY_TABLE[commandName] ?? null;

function streamReply(count, valueBytes) {
  const entries = Array.from({ length: count }, (unused, index) => [Buffer.from(`${index + 1}-0`), bulk("f", "y".repeat(valueBytes))]);
  return [[Buffer.from("s"), entries]];
}

test("xreadgroup no_ack never loses entries: it reads into the PEL and acks only what it returns", async () => {
  const { runOperation, state } = createTestRunner({
    environment: { REDIS_MAX_RESULT_BYTES: "2048" },
    responders: { xreadgroup: () => streamReply(6, 900) },
  });
  const output = await runOperation("xreadgroup", { key: "s", group: "g", consumer: "c", count: 6, no_ack: true });
  const readCommand = state.commands.find((command) => command[0] === "xreadgroup");
  assert.ok(!readCommand.includes("NOACK"), "NOACK would drop entries the cap cuts off");
  assert.equal(output.data.count, 2);
  assert.equal(output.data.truncated, true);
  assert.deepEqual(state.commands.find((command) => command[0] === "xack"), ["xack", "s", "g", "1-0", "2-0"]);
  assert.deepEqual(output.data.pending_ids, ["3-0", "4-0", "5-0", "6-0"]);
  assert.match(output.data.hint, /"0"/);
});

test("xreadgroup no_ack acks everything when it all fits", async () => {
  const { runOperation, state } = createTestRunner({ responders: { xreadgroup: () => streamReply(2, 10) } });
  const output = await runOperation("xreadgroup", { key: "s", group: "g", consumer: "c", no_ack: true });
  assert.equal(output.data.truncated, false);
  assert.deepEqual(state.commands.at(-1), ["xack", "s", "g", "1-0", "2-0"]);
  assert.equal(output.data.pending_ids, undefined);
});

test("xreadgroup without no_ack reports the ids the cap left out and how to re-read them", async () => {
  const { runOperation, state } = createTestRunner({
    environment: { REDIS_MAX_RESULT_BYTES: "2048" },
    responders: { xreadgroup: () => streamReply(4, 900) },
  });
  const output = await runOperation("xreadgroup", { key: "s", group: "g", consumer: "c" });
  assert.equal(output.data.count, 2);
  assert.deepEqual(output.data.pending_ids, ["3-0", "4-0"]);
  assert.match(output.data.hint, /id "0"/);
  assert.ok(!state.commands.some((command) => command[0] === "xack"));
});

test("mget applies the total result cap and lists the omitted keys", async () => {
  const { runOperation } = createTestRunner({
    environment: { REDIS_MAX_RESULT_BYTES: "2200", REDIS_MAX_VALUE_BYTES: "1000" },
    responders: { strlen: () => 1000, get: () => Buffer.from("x".repeat(1000)) },
  });
  const output = await runOperation("mget", { keys: ["b0", "b1", "b2", "b3", "b4"] }, AS_TOOL);
  assert.ok(JSON.stringify(output.data).length <= 2200 + 200, String(JSON.stringify(output.data).length));
  assert.equal(output.data.values.length, 2);
  assert.equal(output.data.truncated, true);
  assert.deepEqual(output.data.omitted_keys, ["b2", "b3", "b4"]);
});

test("mget: WRONGTYPE becomes null, other errors (timeouts) are raised", async () => {
  const wrongType = createTestRunner({ responders: { strlen: ([key]) => (key === "list" ? replyError("WRONGTYPE Operation against a key holding the wrong kind of value") : 0) } });
  const output = await wrongType.runOperation("mget", { keys: ["list", "nope"] });
  assert.deepEqual(output.data.values.map((entry) => entry.value), [null, null]);
  const timedOut = createTestRunner({ responders: { strlen: () => new Error("Command timed out") } });
  await assert.rejects(timedOut.runOperation("mget", { keys: ["k1"] }), { kind: "timeout", retryable: true });
  const lateTimeout = createTestRunner({ responders: { strlen: () => 3, get: () => new Error("Command timed out") } });
  await assert.rejects(lateTimeout.runOperation("mget", { keys: ["k1"] }), { kind: "timeout" });
});

for (const [caseName, command, args] of [
  ["COPY with DB", "COPY", ["l", "l", "DB", "1"]],
  ["SLOWLOG", "SLOWLOG", ["GET", "5"]],
  ["INFO", "INFO", ["keyspace"]],
  ["LATENCY RESET", "LATENCY", ["RESET"]],
]) {
  test(`command with REDIS_KEY_PREFIX refuses ${caseName}`, async () => {
    const { runOperation, state } = createTestRunner({ loadFinder, environment: { REDIS_KEY_PREFIX: "t1:" } });
    await assert.rejects(runOperation("command", { command, args }), { kind: "permission_denied" });
    assert.equal(state.commands.length, 0);
  });
}

test("command without a prefix still allows INFO and COPY within the database", async () => {
  const { runOperation } = createTestRunner({ loadFinder, responders: { info: () => Buffer.from("# Server"), copy: () => 1 } });
  await runOperation("command", { command: "INFO", args: ["server"] });
  await runOperation("command", { command: "COPY", args: ["a", "b"] });
});

test("scan returns every key of the page so the cursor stays consistent", async () => {
  const keys = Array.from({ length: 1500 }, (unused, index) => `k${index}`);
  const { runOperation } = createTestRunner({ responders: { scan: () => [Buffer.from("77"), bulk(...keys)] } });
  const output = await runOperation("scan", { count: 1000 }, AS_TOOL);
  assert.equal(output.data.keys.length, 1500);
  assert.equal(output.next_cursor, "77");
});

test("binary keys listed by scan can be read and deleted with {base64} or base64: keys", async () => {
  const binaryKey = Buffer.from([0xff, 0x01]);
  const { runOperation, state } = createTestRunner({
    environment: { REDIS_KEY_PREFIX: "t1:" },
    responders: { scan: () => [Buffer.from("0"), [Buffer.concat([Buffer.from("t1:"), binaryKey])]], strlen: () => 1, get: () => Buffer.from("v") },
  });
  const listed = await runOperation("scan", {}, AS_TOOL);
  assert.deepEqual(listed.data.keys, [{ base64: "/wE=" }]);
  await runOperation("get", { key: listed.data.keys[0] }, AS_TOOL);
  assert.deepEqual(state.rawCommands.at(-1)[1], Buffer.concat([Buffer.from("t1:"), binaryKey]));
  await runOperation("del", { keys: ["base64:/wE="] });
  assert.deepEqual(state.rawCommands.at(-1)[1], Buffer.concat([Buffer.from("t1:"), binaryKey]));
  await runOperation("get", { key: "base64:aGk=" }, AS_TOOL);
  assert.equal(state.rawCommands.at(-1)[1], "t1:base64:aGk=", "a base64: name that decodes to UTF-8 is an ordinary key");
  await assert.rejects(runOperation("get", { key: { base64: "not base64!" } }), { kind: "invalid_input" });
});

test("hash field names listed as base64: can be read back with hget and hdel", async () => {
  const { runOperation, state } = createTestRunner({ responders: { hstrlen: () => 1, hget: () => Buffer.from("x") } });
  await runOperation("hget", { key: "h", field: "base64:/w==" });
  assert.deepEqual(state.rawCommands.at(-1)[2], Buffer.from([0xff]));
  await runOperation("hdel", { key: "h", fields: [{ base64: "/w==" }] });
  assert.deepEqual(state.rawCommands.at(-1)[2], Buffer.from([0xff]));
  await runOperation("hset", { key: "h", fields: { "base64:/w==": "v" } });
  assert.deepEqual(state.rawCommands.at(-1)[2], Buffer.from([0xff]));
});

test("hget checks HSTRLEN and never loads a field above REDIS_MAX_VALUE_BYTES", async () => {
  const { runOperation, state } = createTestRunner({ environment: { REDIS_MAX_VALUE_BYTES: "1000" }, responders: { hstrlen: () => 5000, hexists: () => 1 } });
  const output = await runOperation("hget", { key: "h", field: "f" }, AS_TOOL);
  assert.ok(!state.commands.some((command) => command[0] === "hget"));
  assert.deepEqual(output.data, { key: "h", field: "f", value: null, exists: true, truncated: true, size: 5000 });
});

test("hget of a small or missing field", async () => {
  const small = createTestRunner({ responders: { hstrlen: () => 4, hget: () => Buffer.from("Budi") } });
  assert.equal((await small.runOperation("hget", { key: "h", field: "name" })).data.value, "Budi");
  const missing = createTestRunner({ responders: { hstrlen: () => 0, hget: () => null } });
  assert.equal((await missing.runOperation("hget", { key: "h", field: "nope" })).data.exists, false);
});

test("redactor hides password= in the URL query string", () => {
  const url = "redis://127.0.0.1:6379/0?password=Sup3rSecret&db=1";
  const redact = createRedactor(buildUrlSecrets(url));
  assert.doesNotMatch(redact(`AUTH failed with Sup3rSecret for ${url}`), /Sup3rSecret/);
  assert.equal(redact("other redis://h/0?password=Another1&x=1"), "other redis://h/0?password=[redacted]&x=1");
});
