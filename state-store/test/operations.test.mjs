import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { DAY_MS } from "../lib/limits.mjs";
import { createTestRunner, createTestStore, START_TIME_MS } from "./helpers.mjs";

async function withStore(testBody) {
  const testStore = await createTestStore();
  try {
    await testBody(createTestRunner(testStore), testStore);
  } finally {
    await testStore.cleanup();
  }
}

async function readStateDocument(testStore, namespace) {
  return JSON.parse(await readFile(join(testStore.storeDirectory, `${namespace}.json`), "utf8"));
}

test("manifest: local only, every operation a node, clear_namespace not a tool", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.permissions, { network: false, secrets: false, env: ["STATE_STORE_DIR"] });
  const operationNames = ["filter_unseen", "mark_seen", "is_seen", "forget_seen", "get", "set", "delete", "list_keys", "increment", "list_namespaces", "clear_namespace"];
  assert.deepEqual(manifest.nodes.map((node) => node.kind), operationNames.map((name) => `state-store.${name}`));
  assert.deepEqual(manifest.tools.map((tool) => tool.name), operationNames.filter((name) => name !== "clear_namespace"));
  assert.ok(manifest.nodes.every((node) => !("access_token" in node.config_schema.properties)));
});

test("filter_unseen returns new ids in input order and marks them in the same step", () =>
  withStore(async (runOperation) => {
    const first = await runOperation("filter_unseen", { namespace: "comments", ids: ["c3", "c1", "c3", 42] });
    assert.deepEqual(first.data, { new_ids: ["c3", "c1", "42"], new_count: 3, seen_count: 0, marked: true, dropped_count: 0 });
    const second = await runOperation("filter_unseen", { namespace: "comments", ids: ["c1", "c4", "42"] });
    assert.deepEqual(second.data.new_ids, ["c4"]);
    assert.equal(second.data.seen_count, 2);
  }));

test("filter_unseen with mark=false reads only and creates no file", () =>
  withStore(async (runOperation, testStore) => {
    const result = await runOperation("filter_unseen", { namespace: "comments", ids: ["a"], mark: "false" });
    assert.deepEqual(result.data.new_ids, ["a"]);
    assert.equal(result.data.marked, false);
    assert.deepEqual(await readdir(testStore.storeDirectory), []);
    assert.deepEqual((await runOperation("filter_unseen", { namespace: "comments", ids: ["a"], mark: false })).data.new_ids, ["a"]);
  }));

test("filter_unseen accepts ids as a JSON string from a template", () =>
  withStore(async (runOperation) => {
    const result = await runOperation("filter_unseen", { namespace: "comments", ids: '["x","y"]' });
    assert.deepEqual(result.data.new_ids, ["x", "y"]);
  }));

test("seen ids expire after ttl_days since they were last marked", () =>
  withStore(async (runOperation, testStore) => {
    await runOperation("mark_seen", { namespace: "orders", ids: ["o1", "o2"], ttl_days: 2 });
    testStore.clock.advanceBy(DAY_MS);
    await runOperation("mark_seen", { namespace: "orders", ids: ["o2"], ttl_days: 2 });
    testStore.clock.advanceBy(DAY_MS + 1);
    const result = await runOperation("filter_unseen", { namespace: "orders", ids: ["o1", "o2"], mark: false });
    assert.deepEqual(result.data.new_ids, ["o1"]);
    const seenState = await runOperation("is_seen", { namespace: "orders", item_id: "o2" });
    assert.equal(seenState.data.seen, true);
    assert.equal(seenState.data.seen_at, new Date(START_TIME_MS).toISOString());
    assert.equal(seenState.data.expires_at, new Date(START_TIME_MS + 3 * DAY_MS).toISOString());
  }));

test("re-marking ids marked within the last hour does not rewrite the file", () =>
  withStore(async (runOperation, testStore) => {
    await runOperation("filter_unseen", { namespace: "n", ids: ["a", "b"] });
    const fileBefore = await readFile(join(testStore.storeDirectory, "n.json"), "utf8");
    testStore.clock.advanceBy(59 * 60000);
    assert.deepEqual((await runOperation("filter_unseen", { namespace: "n", ids: ["b", "a"] })).data.new_ids, []);
    await runOperation("mark_seen", { namespace: "n", ids: ["a"] });
    assert.equal(await readFile(join(testStore.storeDirectory, "n.json"), "utf8"), fileBefore);
  }));

test("re-marking ids marked over an hour ago refreshes their expiry", () =>
  withStore(async (runOperation, testStore) => {
    await runOperation("mark_seen", { namespace: "n", ids: ["a"], ttl_days: 1 });
    testStore.clock.advanceBy(61 * 60000);
    await runOperation("filter_unseen", { namespace: "n", ids: ["a"], ttl_days: 1 });
    const seenEntry = (await readStateDocument(testStore, "n")).seen[0];
    assert.deepEqual(seenEntry, ["a", START_TIME_MS, START_TIME_MS + 61 * 60000 + DAY_MS]);
  }));

test("updates that change nothing write nothing", () =>
  withStore(async (runOperation, testStore) => {
    assert.deepEqual((await runOperation("delete", { namespace: "n", key: "missing" })).data.deleted, false);
    assert.deepEqual((await runOperation("forget_seen", { namespace: "n", ids: ["missing"] })).data.forgotten_count, 0);
    assert.deepEqual(await readdir(testStore.storeDirectory), []);
    await runOperation("set", { namespace: "n", key: "k", value: 1 });
    const fileBefore = await readFile(join(testStore.storeDirectory, "n.json"), "utf8");
    testStore.clock.advanceBy(60000);
    await runOperation("forget_seen", { namespace: "n", ids: ["missing"] });
    await runOperation("delete", { namespace: "n", key: "missing" });
    assert.equal(await readFile(join(testStore.storeDirectory, "n.json"), "utf8"), fileBefore);
  }));

test("expired ids are purged from the file on the next write", () =>
  withStore(async (runOperation, testStore) => {
    await runOperation("mark_seen", { namespace: "orders", ids: ["old"], ttl_days: 1 });
    testStore.clock.advanceBy(DAY_MS);
    await runOperation("mark_seen", { namespace: "orders", ids: ["new"] });
    assert.deepEqual((await readStateDocument(testStore, "orders")).seen.map(([id]) => id), ["new"]);
  }));

test("mark_seen keeps numeric-looking ids in least-recently-seen order and reports new ones", () =>
  withStore(async (runOperation, testStore) => {
    await runOperation("mark_seen", { namespace: "n", ids: ["20", "3", "100"] });
    testStore.clock.advanceBy(2 * 3600000);
    const result = await runOperation("mark_seen", { namespace: "n", ids: ["3", "7"] });
    assert.deepEqual(result.data, { marked_count: 2, new_count: 1, dropped_count: 0 });
    assert.deepEqual((await readStateDocument(testStore, "n")).seen.map(([id]) => id), ["20", "100", "3", "7"]);
  }));

test("is_seen and forget_seen", () =>
  withStore(async (runOperation) => {
    await runOperation("mark_seen", { namespace: "n", ids: ["a", "b"] });
    assert.equal((await runOperation("is_seen", { namespace: "n", item_id: "a" })).data.seen, true);
    assert.deepEqual((await runOperation("forget_seen", { namespace: "n", ids: ["a", "zzz"] })).data, { forgotten_count: 1 });
    assert.deepEqual((await runOperation("is_seen", { namespace: "n", item_id: "a" })).data, { id: "a", seen: false, seen_at: null, expires_at: null });
  }));

test("get, set with TTL, delete", () =>
  withStore(async (runOperation, testStore) => {
    const stored = await runOperation("set", { namespace: "cfg", key: "cursor", value: { page: 2, tags: ["a"] }, ttl_seconds: 60 });
    assert.equal(stored.data.expires_at, new Date(START_TIME_MS + 60000).toISOString());
    assert.deepEqual((await runOperation("get", { namespace: "cfg", key: "cursor" })).data.value, { page: 2, tags: ["a"] });
    testStore.clock.advanceBy(60000);
    assert.deepEqual((await runOperation("get", { namespace: "cfg", key: "cursor" })).data, { key: "cursor", found: false, value: null, updated_at: null, expires_at: null });
    await runOperation("set", { namespace: "cfg", key: "flag", value: false });
    assert.equal((await runOperation("get", { namespace: "cfg", key: "flag" })).data.value, false);
    assert.deepEqual((await runOperation("delete", { namespace: "cfg", key: "flag" })).data, { key: "flag", deleted: true });
    assert.deepEqual((await runOperation("delete", { namespace: "cfg", key: "flag" })).data, { key: "flag", deleted: false });
  }));

test("list_keys filters by prefix, sorts and paginates", () =>
  withStore(async (runOperation) => {
    for (const key of ["user:3", "user:1", "user:2", "other"]) await runOperation("set", { namespace: "kv", key, value: 1 });
    const firstPage = await runOperation("list_keys", { namespace: "kv", prefix: "user:", limit: 2 });
    assert.deepEqual(firstPage.data.keys.map((entry) => entry.key), ["user:1", "user:2"]);
    assert.equal(firstPage.next_cursor, "user:2");
    const secondPage = await runOperation("list_keys", { namespace: "kv", prefix: "user:", limit: 2, cursor: firstPage.next_cursor });
    assert.deepEqual(secondPage.data.keys.map((entry) => entry.key), ["user:3"]);
    assert.equal(secondPage.next_cursor, null);
  }));

test("increment counts, applies ttl only on creation, and rejects non-integers", () =>
  withStore(async (runOperation, testStore) => {
    assert.equal((await runOperation("increment", { namespace: "c", key: "sent", ttl_seconds: 10 })).data.value, 1);
    testStore.clock.advanceBy(5000);
    const second = await runOperation("increment", { namespace: "c", key: "sent", by: "4", ttl_seconds: 10 });
    assert.equal(second.data.value, 5);
    assert.equal(second.data.expires_at, new Date(START_TIME_MS + 10000).toISOString());
    testStore.clock.advanceBy(5000);
    assert.equal((await runOperation("increment", { namespace: "c", key: "sent", by: -2 })).data.value, -2);
    await runOperation("set", { namespace: "c", key: "text", value: "hello" });
    await assert.rejects(runOperation("increment", { namespace: "c", key: "text" }), { kind: "invalid_input" });
    await runOperation("set", { namespace: "c", key: "big", value: Number.MAX_SAFE_INTEGER });
    await assert.rejects(runOperation("increment", { namespace: "c", key: "big" }), { kind: "invalid_input" });
  }));

test("list_namespaces and clear_namespace (node only)", () =>
  withStore(async (runOperation) => {
    await runOperation("mark_seen", { namespace: "b-ns", ids: ["1"] });
    await runOperation("set", { namespace: "a-ns", key: "k", value: 1 });
    const listed = await runOperation("list_namespaces", { limit: 1 });
    assert.equal(listed.data.namespaces[0].namespace, "a-ns");
    assert.ok(listed.data.namespaces[0].bytes > 0);
    assert.equal(listed.next_cursor, "a-ns");
    await assert.rejects(runOperation("clear_namespace", { namespace: "b-ns" }, { source: "tool" }), { kind: "invalid_input" });
    assert.deepEqual((await runOperation("clear_namespace", { namespace: "b-ns" }, { source: "node" })).data, { namespace: "b-ns", cleared: true });
    assert.deepEqual((await runOperation("clear_namespace", { namespace: "b-ns" }, { source: "node" })).data, { namespace: "b-ns", cleared: false });
    assert.deepEqual((await runOperation("list_namespaces", {})).data.namespaces.map((entry) => entry.namespace), ["a-ns"]);
  }));

test("validation errors are invalid_input", async (t) => {
  const invalidCalls = [
    ["bad namespace characters", "filter_unseen", { namespace: "../etc", ids: ["a"] }],
    ["upper-case namespace", "get", { namespace: "Orders", key: "k" }],
    ["namespace too long", "get", { namespace: "a".repeat(65), key: "k" }],
    ["ids not an array", "mark_seen", { namespace: "n", ids: "a,b" }],
    ["empty id", "mark_seen", { namespace: "n", ids: [""] }],
    ["object id", "mark_seen", { namespace: "n", ids: [{ id: 1 }] }],
    ["id too long", "mark_seen", { namespace: "n", ids: ["x".repeat(257)] }],
    ["id over 256 UTF-8 bytes", "mark_seen", { namespace: "n", ids: ["é".repeat(129)] }],
    ["id over 256 bytes once JSON-escaped", "mark_seen", { namespace: "n", ids: ["\u0001".repeat(50)] }],
    ["too many ids", "filter_unseen", { namespace: "n", ids: Array.from({ length: 10001 }, (_, index) => `i${index}`) }],
    ["ttl_days 0", "mark_seen", { namespace: "n", ids: ["a"], ttl_days: 0 }],
    ["key too long", "set", { namespace: "n", key: "k".repeat(513), value: 1 }],
    ["value over 1 MB", "set", { namespace: "n", key: "k", value: "v".repeat(1024 * 1024) }],
    ["missing value", "set", { namespace: "n", key: "k" }],
    ["fractional by", "increment", { namespace: "n", key: "k", by: 1.5 }],
  ];
  for (const [caseName, operationName, args] of invalidCalls) {
    await t.test(caseName, () => withStore(async (runOperation) => assert.rejects(runOperation(operationName, args), { kind: "invalid_input" })));
  }
});

test("ids up to 256 UTF-8 bytes are accepted, so 100000 ids always fit in the file size limit", () =>
  withStore(async (runOperation) => {
    const result = await runOperation("filter_unseen", { namespace: "n", ids: ["é".repeat(128), "x".repeat(256)] });
    assert.equal(result.data.new_count, 2);
  }));

test("a relative STATE_STORE_DIR is rejected; ~/ is expanded", async () => {
  const testStore = await createTestStore();
  const relativeRunner = createTestRunner({ ...testStore, environment: { STATE_STORE_DIR: "relative/dir" } });
  await assert.rejects(relativeRunner("get", { namespace: "n", key: "k" }), { kind: "invalid_input" });
  const homeRunner = createTestRunner({ ...testStore, environment: { STATE_STORE_DIR: "~/store" } }, { homeDirectory: testStore.storeDirectory });
  await homeRunner("set", { namespace: "n", key: "k", value: 1 });
  assert.ok((await stat(join(testStore.storeDirectory, "store", "n.json"))).isFile());
  await testStore.cleanup();
});

test("files are private and leave no temp or lock files behind", () =>
  withStore(async (runOperation, testStore) => {
    await runOperation("set", { namespace: "n", key: "k", value: 1 });
    assert.deepEqual(await readdir(testStore.storeDirectory), ["n.json"]);
    assert.equal((await stat(join(testStore.storeDirectory, "n.json"))).mode & 0o777, 0o600);
  }));

test("leftover temp files from a crashed writer are removed on the next write", () =>
  withStore(async (runOperation, testStore) => {
    const leftoverName = `n.json.${"a".repeat(32)}.tmp`;
    await writeFile(join(testStore.storeDirectory, leftoverName), "partial");
    await writeFile(join(testStore.storeDirectory, "other.json.tmp"), "not ours");
    await runOperation("set", { namespace: "n", key: "k", value: 1 });
    assert.deepEqual((await readdir(testStore.storeDirectory)).sort(), ["n.json", "other.json.tmp"]);
  }));
