import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { TEST_PASSWORD, TEST_URL, createTestRunner, replyError } from "./helpers.mjs";

const AS_TOOL = { source: "tool" };
const WRITABLE = { REDIS_TOOL_ALLOW_WRITES: "1" };
const bulk = (...texts) => texts.map((text) => (Buffer.isBuffer(text) ? text : Buffer.from(String(text))));

test("manifest: command is node only, everything else is a tool, env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  const toolNames = manifest.tools.map((tool) => tool.name);
  assert.equal(toolNames.length, 30);
  assert.ok(!toolNames.includes("command"));
  assert.ok(manifest.nodes.some((node) => node.kind === "redis.command"));
  assert.ok(!toolNames.includes("keys"));
  assert.deepEqual(manifest.permissions.env, [
    "REDIS_URL", "REDIS_KEY_PREFIX", "REDIS_TOOL_ALLOW_WRITES", "REDIS_MAX_VALUE_BYTES", "REDIS_MAX_RESULT_BYTES", "REDIS_COMMAND_TIMEOUT_MS", "REDIS_IDLE_MINUTES",
  ]);
});

test("no URL → auth_error before loading ioredis; a non-redis URL is refused", async () => {
  const missing = createTestRunner({ environment: { REDIS_URL: "" } });
  await assert.rejects(missing.runOperation("get", { key: "a" }), { kind: "auth_error" });
  assert.equal(missing.state.loadCount, 0);
  const wrong = createTestRunner({ environment: { REDIS_URL: "http://x:pw-secret@h" } });
  await assert.rejects(wrong.runOperation("get", { key: "a" }), (error) => error.kind === "invalid_input" && !error.message.includes("pw-secret"));
});

test("connection options: lazy, bounded timeouts, no retries or offline queue", async () => {
  const { runOperation, state } = createTestRunner({ environment: { REDIS_COMMAND_TIMEOUT_MS: "2500" } });
  await runOperation("get", { key: "a" });
  const { options } = state.connections[0];
  assert.equal(options.lazyConnect, true);
  assert.equal(options.connectTimeout, 10000);
  assert.equal(options.commandTimeout, 2500);
  assert.equal(options.maxRetriesPerRequest, 0);
  assert.equal(options.retryStrategy(), null);
  assert.equal(options.enableOfflineQueue, false);
});

test("get reads small values with GET and decodes UTF-8", async () => {
  const { runOperation, state } = createTestRunner({ responders: { strlen: () => 5, get: () => Buffer.from("halo!") } });
  const output = await runOperation("get", { key: "greeting" });
  assert.deepEqual(state.commands, [["strlen", "greeting"], ["get", "greeting"]]);
  assert.deepEqual(output.data, { key: "greeting", value: "halo!", exists: true, truncated: false, size: 5 });
});

test("get of a missing key returns null", async () => {
  const { runOperation } = createTestRunner();
  const output = await runOperation("get", { key: "nope" });
  assert.equal(output.data.value, null);
  assert.equal(output.data.exists, false);
});

test("get never loads a value above REDIS_MAX_VALUE_BYTES: GETRANGE and truncated", async () => {
  const { runOperation, state } = createTestRunner({
    environment: { REDIS_MAX_VALUE_BYTES: "4" },
    responders: { strlen: () => 1_000_000, getrange: () => Buffer.from("abcd") },
  });
  const output = await runOperation("get", { key: "big" });
  assert.deepEqual(state.commands[1], ["getrange", "big", "0", "3"]);
  assert.equal(output.data.value, "abcd");
  assert.equal(output.data.truncated, true);
  assert.equal(output.data.size, 1_000_000);
});

test("binary values: non-UTF-8 comes back as {base64}, or base64 with encoding: base64", async () => {
  const bytes = Buffer.from([0xff, 0x00, 0x10]);
  const { runOperation } = createTestRunner({ responders: { strlen: () => 3, get: () => bytes } });
  assert.deepEqual((await runOperation("get", { key: "bin" })).data.value, { base64: "/wAQ" });
  assert.equal((await runOperation("get", { key: "bin", encoding: "base64" })).data.value, "/wAQ");
});

test("set sends the raw bytes and options, binary-safe with base64", async () => {
  const { runOperation, state } = createTestRunner();
  await runOperation("set", { key: "k", value: "/wAQ", encoding: "base64", ex: 60, nx: true });
  const [commandName, key, valueBytes, ...options] = state.rawCommands[0];
  assert.equal(commandName, "set");
  assert.equal(key, "k");
  assert.deepEqual(valueBytes, Buffer.from([0xff, 0x00, 0x10]));
  assert.deepEqual(options, ["EX", 60, "NX"]);
});

test("set validates options, base64 and the value size", async () => {
  const { runOperation, state } = createTestRunner({ environment: { REDIS_MAX_VALUE_BYTES: "8" } });
  await assert.rejects(runOperation("set", { key: "k", value: "v", ex: 1, px: 1 }), { kind: "invalid_input" });
  await assert.rejects(runOperation("set", { key: "k", value: "v", nx: true, xx: true }), { kind: "invalid_input" });
  await assert.rejects(runOperation("set", { key: "k", value: "not base64!", encoding: "base64" }), { kind: "invalid_input" });
  await assert.rejects(runOperation("set", { key: "k", value: "123456789" }), { kind: "invalid_input", message: /REDIS_MAX_VALUE_BYTES/ });
  assert.equal(state.commands.length, 0);
});

test("set reports written: false when NX/XX blocks it", async () => {
  const { runOperation } = createTestRunner({ responders: { set: () => null } });
  assert.equal((await runOperation("set", { key: "k", value: "v", nx: true })).data.written, false);
});

test("REDIS_KEY_PREFIX is applied to every key and channel", async () => {
  const { runOperation, state } = createTestRunner({ environment: { REDIS_KEY_PREFIX: "tenant-a:" } });
  await runOperation("mget", { keys: ["x", "y"] });
  await runOperation("del", { keys: ["x"] });
  await runOperation("hset", { key: "h", fields: { f: "v" } });
  await runOperation("zadd", { key: "z", members: [{ member: "m", score: 1 }] });
  await runOperation("xadd", { key: "s", fields: { a: "1" } });
  await runOperation("publish", { channel: "events", message: "hi" });
  const keysSent = state.commands.map((command) => command[1]);
  assert.ok(keysSent.every((key) => key.startsWith("tenant-a:")), keysSent.join(", "));
  assert.equal(state.commands.find((command) => command[0] === "publish")[1], "tenant-a:events");
});

test("scan uses MATCH with the escaped prefix, strips it, never sends KEYS", async () => {
  const { runOperation, state } = createTestRunner({
    environment: { REDIS_KEY_PREFIX: "shop[1]:" },
    responders: { scan: () => [Buffer.from("42"), bulk("shop[1]:cart:1", "shop[1]:cart:2")] },
  });
  const output = await runOperation("scan", { match: "cart:*", count: 50, type: "string" }, AS_TOOL);
  assert.deepEqual(state.commands[0], ["scan", "0", "MATCH", "shop\\[1\\]:cart:*", "COUNT", "50", "TYPE", "string"]);
  assert.deepEqual(output.data.keys, ["cart:1", "cart:2"]);
  assert.equal(output.next_cursor, "42");
  assert.equal(output.data.next_cursor, "42");
  assert.ok(!state.commands.some((command) => command[0] === "keys"));
});

test("scan refuses a cursor that is not a number", async () => {
  const { runOperation } = createTestRunner();
  await assert.rejects(runOperation("scan", { cursor: "0 MATCH *" }), { kind: "invalid_input" });
});

const WRITE_CALLS = [
  ["set", { key: "k", value: "v" }],
  ["del", { keys: ["k"] }],
  ["expire", { key: "k", seconds: 10 }],
  ["incr", { key: "k" }],
  ["incrby", { key: "k", increment: 5 }],
  ["hset", { key: "h", fields: { a: "1" } }],
  ["hdel", { key: "h", fields: ["a"] }],
  ["lpush", { key: "l", values: ["a"] }],
  ["rpush", { key: "l", values: ["a"] }],
  ["sadd", { key: "s", members: ["a"] }],
  ["srem", { key: "s", members: ["a"] }],
  ["zadd", { key: "z", members: [{ member: "a", score: 1 }] }],
  ["zrem", { key: "z", members: ["a"] }],
  ["publish", { channel: "c", message: "m" }],
  ["xadd", { key: "st", fields: { a: "1" } }],
  ["xreadgroup", { key: "st", group: "g", consumer: "c" }],
  ["xgroup_create", { key: "st", group: "g" }],
  ["xack", { key: "st", group: "g", ids: ["1-0"] }],
];

for (const [operationName, args] of WRITE_CALLS) {
  test(`${operationName}: tools need REDIS_TOOL_ALLOW_WRITES=1, nodes always may`, async () => {
    const readOnly = createTestRunner();
    await assert.rejects(readOnly.runOperation(operationName, args, AS_TOOL), { kind: "permission_denied", message: /REDIS_TOOL_ALLOW_WRITES=1/ });
    assert.equal(readOnly.state.loadCount, 0);
    await readOnly.runOperation(operationName, args);
    const writable = createTestRunner({ environment: WRITABLE });
    await writable.runOperation(operationName, args, AS_TOOL);
    assert.ok(writable.state.commands.length >= 1);
  });
}

const READ_CALLS = [
  ["get", { key: "k" }], ["mget", { keys: ["k"] }], ["exists", { keys: ["k"] }], ["ttl", { key: "k" }],
  ["hget", { key: "h", field: "f" }], ["hgetall", { key: "h" }], ["lrange", { key: "l" }], ["llen", { key: "l" }],
  ["smembers", { key: "s" }], ["zrange", { key: "z" }], ["scan", {}], ["xrange", { key: "st" }],
];

for (const [operationName, args] of READ_CALLS) {
  test(`${operationName}: allowed for tools without opt-in`, async () => {
    const { runOperation } = createTestRunner();
    await runOperation(operationName, args, AS_TOOL);
  });
}

test("ttl interprets -2 and -1", async () => {
  const missing = createTestRunner({ responders: { ttl: () => -2 } });
  assert.deepEqual((await missing.runOperation("ttl", { key: "k" })).data, { key: "k", exists: false, persistent: false, ttl_seconds: null });
  const persistent = createTestRunner({ responders: { ttl: () => -1 } });
  assert.equal((await persistent.runOperation("ttl", { key: "k" })).data.persistent, true);
  const expiring = createTestRunner({ responders: { ttl: () => 30 } });
  assert.equal((await expiring.runOperation("ttl", { key: "k" })).data.ttl_seconds, 30);
});

test("exists reports which keys exist", async () => {
  const { runOperation } = createTestRunner({ responders: { exists: ([key]) => (key === "a" ? 1 : 0) } });
  assert.deepEqual((await runOperation("exists", { keys: ["a", "b"] })).data, { count: 1, existing: ["a"] });
});

test("hgetall decodes pairs; a huge hash is read with HSCAN and truncated", async () => {
  const small = createTestRunner({ responders: { hlen: () => 3, hscan: () => [Buffer.from("0"), bulk("name", "Budi", "city", "Bandung", Buffer.from([0xff]), "x")] } });
  assert.deepEqual((await small.runOperation("hgetall", { key: "u" })).data.fields, { name: "Budi", city: "Bandung", "base64:/w==": "x" });
  assert.ok(!small.state.commands.some((command) => command[0] === "hgetall"));
  let round = 0;
  const huge = createTestRunner({ responders: { hlen: () => 50_000, hscan: () => [Buffer.from(String(++round)), bulk(`f${round}`, "1")] } });
  const output = await huge.runOperation("hgetall", { key: "u" });
  assert.deepEqual(huge.state.commands[1], ["hscan", "u", "0", "COUNT", "1000"]);
  assert.deepEqual(huge.state.commands[2], ["hscan", "u", "1", "COUNT", "1000"]);
  assert.equal(huge.state.commands.length, 21, "HLEN plus at most 20 HSCAN rounds");
  assert.equal(output.data.truncated, true);
  assert.equal(output.data.total, 50_000);
});

test("lrange clamps to 1000 items and reports next_start", async () => {
  const { runOperation, state } = createTestRunner({ responders: { llen: () => 5000, lrange: () => bulk("a", "b") } });
  const output = await runOperation("lrange", { key: "l", start: 0, stop: -1 });
  assert.deepEqual(state.commands[1], ["lrange", "l", "0", "999"]);
  assert.equal(output.data.truncated, true);
  assert.equal(output.data.next_start, 2);
});

test("lrange of an empty range sends no LRANGE", async () => {
  const { runOperation, state } = createTestRunner({ responders: { llen: () => 0 } });
  const output = await runOperation("lrange", { key: "l" });
  assert.deepEqual(output.data.values, []);
  assert.equal(state.commands.length, 1);
});

test("smembers reads at most 1000 members of a bigger set with SRANDMEMBER (bounded by the server)", async () => {
  const { runOperation, state } = createTestRunner({ responders: { scard: () => 2000, srandmember: () => bulk("x", "y") } });
  const output = await runOperation("smembers", { key: "s" });
  assert.deepEqual(state.commands[1], ["srandmember", "s", "1000"]);
  assert.deepEqual(output.data.members, ["x", "y"]);
  assert.equal(output.data.truncated, true);
});

test("zadd sends flags and score/member pairs; zrange returns scores", async () => {
  const { runOperation, state } = createTestRunner({
    responders: { zcard: () => 2, zrange: () => bulk("budi", "120", "sari", "inf") },
  });
  await runOperation("zadd", { key: "board", members: [{ member: "budi", score: 120 }, { member: "sari", score: "99.5" }], condition: "NX", comparison: "GT", changed: true });
  assert.deepEqual(state.commands[0], ["zadd", "board", "NX", "GT", "CH", "120", "budi", "99.5", "sari"]);
  const output = await runOperation("zrange", { key: "board", with_scores: true, reverse: true });
  assert.deepEqual(state.commands.at(-1), ["zrange", "board", "0", "1", "REV", "WITHSCORES"]);
  assert.deepEqual(output.data.members, [{ member: "budi", score: 120 }, { member: "sari", score: "+inf" }]);
});

test("zrange by score uses BYSCORE with LIMIT and validates bounds", async () => {
  const { runOperation, state } = createTestRunner();
  await runOperation("zrange", { key: "z", by_score: true, min: "(10", max: "+inf", reverse: true });
  assert.deepEqual(state.commands[0], ["zrange", "z", "+inf", "(10", "BYSCORE", "REV", "LIMIT", "0", "1001"]);
  await assert.rejects(runOperation("zrange", { key: "z", by_score: true, min: "1 LIMIT" }), { kind: "invalid_input" });
  await assert.rejects(runOperation("zadd", { key: "z", members: [{ member: "a", score: "abc" }] }), { kind: "invalid_input" });
});

test("xadd builds MAXLEN ~ and NOMKSTREAM; xrange pages with an exclusive id", async () => {
  const { runOperation, state } = createTestRunner({
    responders: { xrange: () => [[Buffer.from("1-0"), bulk("a", "1")], [Buffer.from("2-0"), bulk("a", "2")]] },
  });
  const added = await runOperation("xadd", { key: "s", fields: { order: "A-1" }, max_length: 1000, no_create: true });
  assert.deepEqual(state.commands[0], ["xadd", "s", "NOMKSTREAM", "MAXLEN", "~", "1000", "*", "order", "A-1"]);
  assert.equal(added.data.id, "1700000000000-0");
  const page = await runOperation("xrange", { key: "s", count: 2 });
  assert.deepEqual(page.data.entries, [{ id: "1-0", fields: { a: "1" } }, { id: "2-0", fields: { a: "2" } }]);
  assert.equal(page.data.next_cursor, "(2-0");
  await assert.rejects(runOperation("xrange", { key: "s", start: "- COUNT 5" }), { kind: "invalid_input" });
});

test("xreadgroup never blocks and decodes entries", async () => {
  const { runOperation, state } = createTestRunner({
    responders: { xreadgroup: () => [[Buffer.from("s"), [[Buffer.from("5-0"), bulk("job", "send")]]]] },
  });
  const output = await runOperation("xreadgroup", { key: "s", group: "workers", consumer: "w1", count: 5 });
  assert.deepEqual(state.commands[0], ["xreadgroup", "GROUP", "workers", "w1", "COUNT", "5", "STREAMS", "s", ">"]);
  assert.ok(!state.commands[0].includes("BLOCK"));
  assert.deepEqual(output.data.entries, [{ id: "5-0", fields: { job: "send" } }]);
});

test("xgroup_create maps BUSYGROUP to conflict; NOGROUP is not_found", async () => {
  const busy = createTestRunner({ responders: { xgroup: () => replyError("BUSYGROUP Consumer Group name already exists") } });
  await assert.rejects(busy.runOperation("xgroup_create", { key: "s", group: "g" }), { kind: "conflict" });
  const missing = createTestRunner({ responders: { xreadgroup: () => replyError("NOGROUP No such key 's' or consumer group 'g'") } });
  await assert.rejects(missing.runOperation("xreadgroup", { key: "s", group: "g", consumer: "c" }), { kind: "not_found" });
});

test("server errors: WRONGTYPE is invalid_input, WRONGPASS auth_error, timeouts retryable", async () => {
  const wrongType = createTestRunner({ responders: { strlen: () => replyError("WRONGTYPE Operation against a key holding the wrong kind of value") } });
  await assert.rejects(wrongType.runOperation("get", { key: "list" }), { kind: "invalid_input" });
  const timedOut = createTestRunner({ responders: { llen: () => new Error("Command timed out") } });
  await assert.rejects(timedOut.runOperation("llen", { key: "l" }), { kind: "timeout", retryable: true });
  const wrongPass = createTestRunner({ connectError: replyError(`WRONGPASS invalid username-password pair for ${TEST_PASSWORD}`) });
  await assert.rejects(wrongPass.runOperation("get", { key: "a" }), (error) => {
    assert.equal(error.kind, "auth_error");
    assert.ok(!error.message.includes(TEST_PASSWORD), error.message);
    return true;
  });
});

test("connection refused is a retryable network_error with the socket cause and no secret", async () => {
  const refused = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:6379 (${TEST_URL})`), { code: "ECONNREFUSED" });
  const { runOperation, state } = createTestRunner({ connectError: refused });
  await assert.rejects(runOperation("get", { key: "a" }), (error) => {
    assert.equal(error.kind, "network_error");
    assert.equal(error.retryable, true);
    assert.match(error.message, /ECONNREFUSED/);
    assert.ok(!error.message.includes(TEST_PASSWORD), error.message);
    return true;
  });
  state.connectError = null;
  await runOperation("get", { key: "a" });
  assert.equal(state.connections.length, 2, "a failed connection is not reused");
});

test("a dropped connection is replaced on the next call", async () => {
  const { runOperation, state } = createTestRunner();
  await runOperation("llen", { key: "l" });
  state.connections[0].status = "end";
  await runOperation("llen", { key: "l" });
  assert.equal(state.connections.length, 2);
});

test("cancelled reads and writes", async () => {
  const { runOperation } = createTestRunner({ delayMs: 200 });
  const readController = new AbortController();
  const read = runOperation("llen", { key: "l" }, { signal: readController.signal });
  setTimeout(() => readController.abort(), 20);
  await assert.rejects(read, { kind: "cancelled" });
  const writeController = new AbortController();
  const write = runOperation("incr", { key: "n" }, { signal: writeController.signal });
  setTimeout(() => writeController.abort(), 20);
  await assert.rejects(write, { kind: "cancelled", message: /may already have been applied/ });
});

test("outputs never contain the URL or password", async () => {
  const { runOperation } = createTestRunner({ responders: { strlen: () => 1, get: () => Buffer.from("x") } });
  const output = await runOperation("get", { key: "a" });
  assert.ok(!JSON.stringify(output).includes(TEST_PASSWORD));
});

test("the connection is pooled and closed after the idle period", async () => {
  const scheduled = [];
  const timers = {
    setTimeout: (callback, delayMs) => {
      const handle = { callback, delayMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout: () => {},
  };
  const { runOperation, state, definition } = createTestRunner({ timers, environment: { REDIS_IDLE_MINUTES: "1" } });
  await runOperation("llen", { key: "l" });
  await runOperation("llen", { key: "l" });
  assert.equal(state.connections.length, 1);
  assert.equal(scheduled.at(-1).delayMs, 60000);
  await scheduled.at(-1).callback();
  assert.equal(state.connections[0].status, "end");
  await definition.closeAllClients();
});

test("TEST_URL is a redis URL with a password (fixture sanity)", () => {
  assert.match(TEST_URL, /^redis:\/\/default:/);
});
