import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFileSystem from "node:fs/promises";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DAY_MS, MAX_SEEN_IDS_PER_NAMESPACE } from "../lib/limits.mjs";
import { createTestRunner, createTestStore } from "./helpers.mjs";

async function withStore(testBody, overrides = {}) {
  const testStore = await createTestStore();
  try {
    await testBody(createTestRunner(testStore, overrides), testStore);
  } finally {
    await testStore.cleanup();
  }
}

const validDocument = { format: "graphrt-state-store", version: 1, namespace: "n", seen: [], values: [] };

test("a corrupt state file fails closed and is never replaced", async (t) => {
  const corruptContents = [
    ["truncated JSON", '{"format":"graphrt-state-store","seen":[["a",1'],
    ["empty file", ""],
    ["wrong format", JSON.stringify({ ...validDocument, format: "other" })],
    ["future version", JSON.stringify({ ...validDocument, version: 2 })],
    ["other namespace", JSON.stringify({ ...validDocument, namespace: "m" })],
    ["seen not an array", JSON.stringify({ ...validDocument, seen: { a: 1 } })],
    ["malformed seen entry", JSON.stringify({ ...validDocument, seen: [["a", "yesterday", 5]] })],
    ["malformed value entry", JSON.stringify({ ...validDocument, values: [{ key: "k" }] })],
  ];
  const operationsToTry = [
    ["filter_unseen", { namespace: "n", ids: ["a"] }],
    ["filter_unseen", { namespace: "n", ids: ["a"], mark: false }],
    ["mark_seen", { namespace: "n", ids: ["a"] }],
    ["get", { namespace: "n", key: "k" }],
    ["increment", { namespace: "n", key: "k" }],
  ];
  for (const [caseName, fileContent] of corruptContents) {
    await t.test(caseName, () =>
      withStore(async (runOperation, testStore) => {
        const dataPath = join(testStore.storeDirectory, "n.json");
        await writeFile(dataPath, fileContent);
        for (const [operationName, args] of operationsToTry) {
          await assert.rejects(runOperation(operationName, args), (error) => {
            assert.equal(error.kind, "state_corrupt");
            assert.match(error.message, /n\.json is unreadable/);
            assert.match(error.message, /Nothing was changed/);
            return true;
          });
        }
        assert.equal(await readFile(dataPath, "utf8"), fileContent);
        assert.deepEqual(await readdir(testStore.storeDirectory), ["n.json"]);
      }),
    );
  }
});

test("a failed rename leaves the old file intact and no temp file", () => {
  const failingFileSystem = {
    ...realFileSystem,
    rename: async (fromPath, toPath) => {
      if (String(toPath).endsWith("n.json") && failingFileSystem.failRename) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      return realFileSystem.rename(fromPath, toPath);
    },
  };
  return withStore(
    async (runOperation, testStore) => {
      await runOperation("mark_seen", { namespace: "n", ids: ["a"] });
      const before = await readFile(join(testStore.storeDirectory, "n.json"), "utf8");
      failingFileSystem.failRename = true;
      await assert.rejects(runOperation("filter_unseen", { namespace: "n", ids: ["a", "b"] }), (error) => {
        assert.equal(error.kind, "storage_error");
        assert.equal(error.retryable, true);
        assert.match(error.message, /nothing was changed/);
        return true;
      });
      assert.equal(await readFile(join(testStore.storeDirectory, "n.json"), "utf8"), before);
      assert.deepEqual(await readdir(testStore.storeDirectory), ["n.json"]);
      failingFileSystem.failRename = false;
      assert.deepEqual((await runOperation("filter_unseen", { namespace: "n", ids: ["a", "b"] })).data.new_ids, ["b"]);
    },
    { fileSystem: failingFileSystem },
  );
});

test("a writer that dies mid-write (fsync fails) leaves the old file intact", () => {
  const failingFileSystem = {
    ...realFileSystem,
    open: async (filePath, ...rest) => {
      const fileHandle = await realFileSystem.open(filePath, ...rest);
      if (!String(filePath).endsWith(".tmp") || !String(filePath).includes("n.json")) return fileHandle;
      return { writeFile: (content) => fileHandle.writeFile(content.slice(0, 10)), sync: async () => { throw Object.assign(new Error("I/O error"), { code: "EIO" }); }, close: () => fileHandle.close() };
    },
  };
  return withStore(
    async (runOperation, testStore) => {
      await assert.rejects(runOperation("set", { namespace: "n", key: "k", value: 1 }), { kind: "storage_error" });
      assert.deepEqual(await readdir(testStore.storeDirectory), []);
    },
    { fileSystem: failingFileSystem },
  );
});

function createFailingLockRemovalFileSystem() {
  return {
    ...realFileSystem,
    rm: async (filePath, ...rest) => {
      if (String(filePath).endsWith(".lock")) throw Object.assign(new Error("I/O error"), { code: "EIO" });
      return realFileSystem.rm(filePath, ...rest);
    },
  };
}

test("a lock release failure after a committed write is logged, and the result is returned", () => {
  const warnings = [];
  return withStore(
    async (runOperation) => {
      assert.deepEqual((await runOperation("filter_unseen", { namespace: "n", ids: ["a"] })).data.new_ids, ["a"]);
      assert.match(warnings.join("\n"), /n\.lock.*EIO/);
      assert.deepEqual((await runOperation("filter_unseen", { namespace: "n", ids: ["a", "b"] })).data.new_ids, ["b"]);
    },
    { fileSystem: createFailingLockRemovalFileSystem(), logWarning: (message) => warnings.push(message) },
  );
});

test("a lock release failure never masks the task's own error", () => {
  const warnings = [];
  return withStore(
    async (runOperation) => {
      await runOperation("set", { namespace: "n", key: "text", value: "hello" });
      await assert.rejects(runOperation("increment", { namespace: "n", key: "text" }), (error) => {
        assert.equal(error.kind, "invalid_input");
        assert.match(error.message, /not an integer/);
        return true;
      });
      assert.ok(warnings.length >= 2);
    },
    { fileSystem: createFailingLockRemovalFileSystem(), logWarning: (message) => warnings.push(message) },
  );
});

test("a write that would exceed the file size limit is rejected and nothing is written", () =>
  withStore(
    async (runOperation, testStore) => {
      await runOperation("set", { namespace: "n", key: "small", value: "x" });
      const before = await readFile(join(testStore.storeDirectory, "n.json"), "utf8");
      await assert.rejects(runOperation("set", { namespace: "n", key: "big", value: "y".repeat(2000) }), (error) => {
        assert.equal(error.kind, "invalid_input");
        assert.match(error.message, /Nothing was written/);
        assert.match(error.message, /holds 0 seen ids and 2 keys/);
        assert.match(error.message, /`delete`.*`forget_seen`.*ttl_days.*several namespaces/);
        return true;
      });
      assert.equal(await readFile(join(testStore.storeDirectory, "n.json"), "utf8"), before);
    },
    { maxFileBytes: 1000 },
  ));

test(`at most ${MAX_SEEN_IDS_PER_NAMESPACE} seen ids: the least recently seen are dropped first`, () =>
  withStore(async (runOperation, testStore) => {
    const batchSize = 10000;
    for (let batchStart = 0; batchStart < MAX_SEEN_IDS_PER_NAMESPACE; batchStart += batchSize) {
      const ids = Array.from({ length: batchSize }, (_, offset) => `id-${batchStart + offset}`);
      await runOperation("mark_seen", { namespace: "big", ids });
    }
    testStore.clock.advanceBy(2 * 3600000);
    await runOperation("mark_seen", { namespace: "big", ids: ["id-0"] });
    const result = await runOperation("filter_unseen", { namespace: "big", ids: ["fresh-1", "fresh-2"] });
    assert.equal(result.data.dropped_count, 2);
    const check = await runOperation("filter_unseen", { namespace: "big", ids: ["id-0", "id-1", "id-2", "id-3", "fresh-1"], mark: false });
    assert.deepEqual(check.data.new_ids, ["id-1", "id-2"]);
  }));

test("a failure to list the store directory for leftover temp files is logged, not swallowed", () => {
  const warnings = [];
  const fileSystem = { ...realFileSystem, readdir: async () => Promise.reject(Object.assign(new Error("I/O error"), { code: "EIO" })) };
  return withStore(
    async (runOperation) => {
      await runOperation("set", { namespace: "n", key: "k", value: 1 });
      assert.match(warnings.join("\n"), /leftover temp files.*EIO/);
    },
    { fileSystem, logWarning: (message) => warnings.push(message) },
  );
});

async function readSeenIds(testStore, namespace) {
  return JSON.parse(await readFile(join(testStore.storeDirectory, `${namespace}.json`), "utf8")).seen.map(([id]) => id);
}

test("a forward clock jump (>30 days since the last write) that would purge most ids skips the purge and warns", () => {
  const warnings = [];
  return withStore(
    async (runOperation, testStore) => {
      await runOperation("mark_seen", { namespace: "n", ids: ["a", "b", "c"], ttl_days: 7 });
      testStore.clock.advanceBy(60 * DAY_MS);
      await runOperation("set", { namespace: "n", key: "k", value: 1 });
      assert.deepEqual(await readSeenIds(testStore, "n"), ["a", "b", "c"]);
      assert.match(warnings.join("\n"), /clock/);
    },
    { logWarning: (message) => warnings.push(message) },
  );
});

test("a long gap that purges at most half of the ids still purges", () => {
  const warnings = [];
  return withStore(
    async (runOperation, testStore) => {
      await runOperation("mark_seen", { namespace: "n", ids: ["old"], ttl_days: 7 });
      await runOperation("mark_seen", { namespace: "n", ids: ["keep-1", "keep-2"], ttl_days: 365 });
      testStore.clock.advanceBy(60 * DAY_MS);
      await runOperation("set", { namespace: "n", key: "k", value: 1 });
      assert.deepEqual(await readSeenIds(testStore, "n"), ["keep-1", "keep-2"]);
      assert.deepEqual(warnings, []);
    },
    { logWarning: (message) => warnings.push(message) },
  );
});
