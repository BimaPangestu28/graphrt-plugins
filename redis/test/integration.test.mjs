/**
 * Integration tests against a REAL, temporary redis-server. Skipped unless
 * REDIS_INTEGRATION=1, `redis-server` is on PATH and ioredis is installed:
 *   REDIS_INTEGRATION=1 node --test test/integration.test.mjs
 *
 * The server runs on a free 127.0.0.1 port with a password, a fresh temp
 * directory and persistence off, and is stopped afterwards; no existing
 * instance or data is touched.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

const PASSWORD = "Integration-Secret-7";
const isEnabled = process.env.REDIS_INTEGRATION === "1";
const hasServer = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
const hasDriver = await import("ioredis").then(() => true, () => false);
const skipReason = !isEnabled ? "set REDIS_INTEGRATION=1 to run" : !hasServer ? "redis-server is not installed" : !hasDriver ? "run npm install first" : false;

describe("redis against a temporary redis-server", { skip: skipReason }, () => {
  let server;
  const definitions = [];
  const createRunner = (environment = {}) => {
    const definition = createPluginDefinition();
    definitions.push(definition);
    const runner = createOperationRunner(definition, { REDIS_URL: `redis://:${PASSWORD}@127.0.0.1:${server.port}/0`, ...environment });
    return (name, args, source = "node") => runner(name, args, { source });
  };

  before(async () => {
    server = await startTemporaryRedis();
  });

  after(async () => {
    await Promise.all(definitions.map((definition) => definition.closeAllClients()));
    await server?.stop();
  });

  test("strings, expiry, counters and binary values", async () => {
    const run = createRunner();
    assert.equal((await run("set", { key: "greeting", value: "halo", ex: 100 })).data.written, true);
    assert.equal((await run("get", { key: "greeting" }, "tool")).data.value, "halo");
    const ttl = await run("ttl", { key: "greeting" }, "tool");
    assert.ok(ttl.data.ttl_seconds > 0 && ttl.data.ttl_seconds <= 100);
    assert.equal((await run("set", { key: "greeting", value: "x", nx: true })).data.written, false);
    await run("set", { key: "bin", value: "/wAQgA==", encoding: "base64" });
    assert.deepEqual((await run("get", { key: "bin" }, "tool")).data.value, { base64: "/wAQgA==" });
    assert.equal((await run("get", { key: "bin", encoding: "base64" }, "tool")).data.value, "/wAQgA==");
    assert.equal((await run("incrby", { key: "n", increment: 41 })).data.value, 41);
    assert.equal((await run("incr", { key: "n" })).data.value, 42);
    const many = await run("mget", { keys: ["greeting", "missing", "n"] }, "tool");
    assert.deepEqual(many.data.values.map((entry) => entry.value), ["halo", null, "42"]);
    assert.deepEqual((await run("exists", { keys: ["greeting", "missing"] }, "tool")).data.existing, ["greeting"]);
    assert.equal((await run("expire", { key: "n", seconds: 50 })).data.applied, true);
    assert.equal((await run("del", { keys: ["n", "missing"] })).data.deleted, 1);
    await assert.rejects(run("set", { key: "x", value: "y" }, "tool"), { kind: "permission_denied" });
  });

  test("large values are read partially", async () => {
    const run = createRunner({ REDIS_MAX_VALUE_BYTES: "1024" });
    const bigRun = createRunner({ REDIS_MAX_VALUE_BYTES: "8192" });
    await bigRun("set", { key: "big", value: "x".repeat(5000) });
    const output = await run("get", { key: "big" });
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.value.length, 1024);
    assert.equal(output.data.size, 5000);
  });

  test("hashes, lists, sets and sorted sets", async () => {
    const run = createRunner();
    assert.equal((await run("hset", { key: "user:1", fields: { name: "Budi", city: "Bandung" } })).data.added, 2);
    assert.equal((await run("hget", { key: "user:1", field: "city" }, "tool")).data.value, "Bandung");
    assert.deepEqual((await run("hgetall", { key: "user:1" }, "tool")).data.fields, { name: "Budi", city: "Bandung" });
    assert.equal((await run("hdel", { key: "user:1", fields: ["city", "nope"] })).data.deleted, 1);
    await run("rpush", { key: "queue", values: ["a", "b", "c"] });
    await run("lpush", { key: "queue", values: ["z"] });
    assert.deepEqual((await run("lrange", { key: "queue" }, "tool")).data.values, ["z", "a", "b", "c"]);
    assert.equal((await run("llen", { key: "queue" }, "tool")).data.length, 4);
    await run("sadd", { key: "tags", members: ["promo", "new", "promo"] });
    assert.deepEqual((await run("smembers", { key: "tags" }, "tool")).data.members.sort(), ["new", "promo"]);
    assert.equal((await run("srem", { key: "tags", members: ["new"] })).data.removed, 1);
    await run("zadd", { key: "board", members: [{ member: "budi", score: 120 }, { member: "sari", score: 99.5 }, { member: "andi", score: 10 }] });
    const top = await run("zrange", { key: "board", start: 0, stop: 1, reverse: true, with_scores: true }, "tool");
    assert.deepEqual(top.data.members, [{ member: "budi", score: 120 }, { member: "sari", score: 99.5 }]);
    const byScore = await run("zrange", { key: "board", by_score: true, min: "(10", max: "+inf" }, "tool");
    assert.deepEqual(byScore.data.members, ["sari", "budi"]);
    assert.equal((await run("zrem", { key: "board", members: ["andi"] })).data.removed, 1);
    await assert.rejects(run("lrange", { key: "user:1" }, "tool"), { kind: "invalid_input", message: /WRONGTYPE/ });
  });

  test("key prefix isolates keys; scan pages within the prefix", async () => {
    const tenantA = createRunner({ REDIS_KEY_PREFIX: "tenant-a:" });
    const tenantB = createRunner({ REDIS_KEY_PREFIX: "tenant-b:" });
    for (let index = 0; index < 25; index += 1) await tenantA("set", { key: `cart:${index}`, value: String(index) });
    await tenantB("set", { key: "cart:0", value: "other" });
    assert.equal((await tenantA("get", { key: "cart:0" })).data.value, "0");
    assert.equal((await tenantB("get", { key: "cart:0" })).data.value, "other");
    const seen = new Set();
    let cursor = "0";
    do {
      const page = await tenantA("scan", { cursor, match: "cart:*", count: 10 }, "tool");
      for (const key of page.data.keys) seen.add(key);
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(seen.size, 25);
    assert.ok([...seen].every((key) => key.startsWith("cart:")));
  });

  test("streams: xadd, xrange paging, consumer group read and ack", async () => {
    const run = createRunner();
    await run("xgroup_create", { key: "orders", group: "workers", start_id: "0" });
    await assert.rejects(run("xgroup_create", { key: "orders", group: "workers" }), { kind: "conflict" });
    const ids = [];
    for (const order of ["A-1", "A-2", "A-3"]) ids.push((await run("xadd", { key: "orders", fields: { order } })).data.id);
    const firstPage = await run("xrange", { key: "orders", count: 2 }, "tool");
    assert.deepEqual(firstPage.data.entries.map((entry) => entry.fields.order), ["A-1", "A-2"]);
    const secondPage = await run("xrange", { key: "orders", start: firstPage.next_cursor, count: 2 }, "tool");
    assert.deepEqual(secondPage.data.entries.map((entry) => entry.fields.order), ["A-3"]);
    const delivered = await run("xreadgroup", { key: "orders", group: "workers", consumer: "w1", count: 10 });
    assert.equal(delivered.data.count, 3);
    assert.equal((await run("xack", { key: "orders", group: "workers", ids })).data.acknowledged, 3);
    const empty = await run("xreadgroup", { key: "orders", group: "workers", consumer: "w1" });
    assert.equal(empty.data.count, 0);
  });

  test("publish and the command escape hatch (with the real key table)", async () => {
    const run = createRunner({ REDIS_KEY_PREFIX: "p:" });
    assert.equal((await run("publish", { channel: "events", message: "hi" })).data.receivers, 0);
    await run("set", { key: "counter", value: "1" });
    assert.equal((await run("command", { command: "INCRBY", args: ["counter", 9] })).data.reply, 10);
    assert.equal((await run("get", { key: "counter" })).data.value, "10");
    await assert.rejects(run("command", { command: "FLUSHALL" }), { kind: "permission_denied" });
    await assert.rejects(run("command", { command: "SCAN", args: ["0"] }), { kind: "permission_denied" });
  });

  test("review: xreadgroup no_ack under the result cap loses nothing", async () => {
    const run = createRunner({ REDIS_KEY_PREFIX: "r1:", REDIS_MAX_RESULT_BYTES: "2048" });
    for (let index = 0; index < 6; index += 1) await run("xadd", { key: "s", fields: { f: "y".repeat(900) } });
    await run("xgroup_create", { key: "s", group: "g", start_id: "0" });
    const first = await run("xreadgroup", { key: "s", group: "g", consumer: "c", count: 6, no_ack: true });
    assert.equal(first.data.truncated, true);
    assert.equal(first.data.pending_ids.length, 6 - first.data.count);
    const seen = new Set(first.data.entries.map((entry) => entry.id));
    for (let round = 0; round < 6 && seen.size < 6; round += 1) {
      const again = await run("xreadgroup", { key: "s", group: "g", consumer: "c", start_id: "0", count: 6, no_ack: true });
      for (const entry of again.data.entries) seen.add(entry.id);
    }
    assert.equal(seen.size, 6, "every entry was delivered");
    const empty = await run("xreadgroup", { key: "s", group: "g", consumer: "c", start_id: "0" });
    assert.equal(empty.data.count, 0, "nothing left pending");
  });

  test("review: mget total cap, hget big field, binary keys and fields", async () => {
    const run = createRunner({ REDIS_KEY_PREFIX: "r2:", REDIS_MAX_RESULT_BYTES: "2200", REDIS_MAX_VALUE_BYTES: "1000" });
    for (let index = 0; index < 5; index += 1) await run("set", { key: `big${index}`, value: "x".repeat(1000) });
    const many = await run("mget", { keys: ["big0", "big1", "big2", "big3", "big4"] }, "tool");
    assert.ok(JSON.stringify(many.data).length < 2600);
    assert.deepEqual(many.data.omitted_keys, ["big2", "big3", "big4"]);
    const raw = createRunner();
    await raw("command", { command: "HSET", args: ["r2:h", "f", "z".repeat(5000)] });
    assert.deepEqual((await run("hget", { key: "h", field: "f" }, "tool")).data, { key: "h", field: "f", value: null, exists: true, truncated: true, size: 5000 });
    await raw("command", { command: "SET", args: ["cjI6/w==", "dg=="], encoding: "base64" });
    const listed = await run("scan", { match: "*" }, "tool");
    const binaryKey = listed.data.keys.find((key) => typeof key === "object");
    assert.deepEqual(binaryKey, { base64: "/w==" });
    assert.equal((await run("get", { key: binaryKey }, "tool")).data.value, "v");
    await raw("command", { command: "HSET", args: ["cjI6aGI=", "/w==", "dg=="], encoding: "base64" });
    const hash = await run("hgetall", { key: "hb" }, "tool");
    assert.deepEqual(hash.data.fields, { "base64:/w==": "v" });
    assert.equal((await run("hget", { key: "hb", field: "base64:/w==" }, "tool")).data.value, "v");
    assert.equal((await run("hdel", { key: "hb", fields: ["base64:/w=="] })).data.deleted, 1);
    assert.equal((await run("del", { keys: [binaryKey] })).data.deleted, 1);
  });

  test("review: command with a prefix refuses COPY DB, SLOWLOG, INFO and LATENCY", async () => {
    const run = createRunner({ REDIS_KEY_PREFIX: "r3:" });
    await run("rpush", { key: "l", values: ["a"] });
    for (const [command, args] of [["COPY", ["l", "l", "DB", "1"]], ["SLOWLOG", ["GET", "5"]], ["INFO", ["keyspace"]], ["LATENCY", ["RESET"]]]) {
      await assert.rejects(run("command", { command, args }), { kind: "permission_denied" }, command);
    }
  });

  test("review: a password in the query string is redacted", async () => {
    const definition = createPluginDefinition();
    definitions.push(definition);
    const runner = createOperationRunner(definition, { REDIS_URL: `redis://127.0.0.1:${server.port}/0?password=Query-Wrong-55` });
    await assert.rejects(runner("get", { key: "a" }, { source: "tool" }), (error) => {
      assert.equal(error.kind, "auth_error");
      assert.doesNotMatch(error.message, /Query-Wrong-55/);
      return true;
    });
  });

  test("a wrong password is an auth_error without the password", async () => {
    const definition = createPluginDefinition();
    definitions.push(definition);
    const runner = createOperationRunner(definition, { REDIS_URL: `redis://:Wrong-Pass-123@127.0.0.1:${server.port}/0` });
    await assert.rejects(runner("get", { key: "a" }, { source: "tool" }), (error) => {
      assert.equal(error.kind, "auth_error");
      assert.doesNotMatch(error.message, /Wrong-Pass-123/);
      return true;
    });
  });
});

describe("redis against an unused port", { skip: !isEnabled ? "set REDIS_INTEGRATION=1 to run" : !hasDriver ? "run npm install first" : false }, () => {
  test("reports a retryable network_error with the password redacted", async () => {
    const port = await findFreePort();
    const definition = createPluginDefinition();
    const runner = createOperationRunner(definition, { REDIS_URL: `redis://:Unused-Secret-9@127.0.0.1:${port}/0` });
    await assert.rejects(runner("get", { key: "a" }, { source: "tool" }), (error) => {
      assert.equal(error.kind, "network_error");
      assert.equal(error.retryable, true);
      assert.doesNotMatch(error.message, /Unused-Secret-9/);
      return true;
    });
    await definition.closeAllClients();
  });
});

async function startTemporaryRedis() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "graphrt-redis-"));
  const port = await findFreePort();
  const child = spawn("redis-server", [
    "--port", String(port), "--bind", "127.0.0.1", "--dir", dataDirectory, "--save", "", "--appendonly", "no",
    "--requirepass", PASSWORD, "--protected-mode", "yes", "--logfile", join(dataDirectory, "redis.log"),
  ], { stdio: "ignore" });
  await waitForPort(port, 15000);
  return {
    port,
    async stop() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isOpen = await new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => socket.end(() => resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (isOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`redis-server did not listen on ${port} within ${timeoutMs} ms`);
}
