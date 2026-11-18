import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as realFileSystem from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTestRunner, createTestStore } from "./helpers.mjs";

const WORKER_PATH = fileURLToPath(new URL("./fixtures/concurrent-worker.mjs", import.meta.url));

// Two plugin processes: separate in-process queues and lockers, different pids, the same directory.
// The file system adds random delays so their lock and read-modify-write steps interleave.
function createTwoRunners(testStore) {
  const jitteryFileSystem = {
    ...realFileSystem,
    readFile: async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
      return realFileSystem.readFile(...args);
    },
  };
  const lockerOptions = (pid) => ({ pid, isProcessAlive: () => true, lockTimeoutMs: 20000 });
  return [
    createTestRunner(testStore, { fileSystem: jitteryFileSystem, lockerOptions: lockerOptions(5001) }),
    createTestRunner(testStore, { fileSystem: jitteryFileSystem, lockerOptions: lockerOptions(5002) }),
  ];
}

test("two runners incrementing one counter lose no updates", async () => {
  const testStore = await createTestStore();
  const runners = createTwoRunners(testStore);
  const increments = Array.from({ length: 40 }, (_, index) => runners[index % 2]("increment", { namespace: "shared", key: "count" }));
  const returnedValues = (await Promise.all(increments)).map((output) => output.data.value);
  assert.deepEqual(returnedValues.sort((left, right) => left - right), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal((await runners[0]("get", { namespace: "shared", key: "count" })).data.value, 40);
  assert.deepEqual(await readdir(testStore.storeDirectory), ["shared.json"]);
  await testStore.cleanup();
});

test("two runners filtering overlapping ids each get every id as new exactly once", async () => {
  const testStore = await createTestStore();
  const runners = createTwoRunners(testStore);
  const allIds = Array.from({ length: 30 }, (_, index) => `item-${index}`);
  const calls = Array.from({ length: 20 }, (_, index) => {
    const windowStart = (index * 3) % 24;
    return runners[index % 2]("filter_unseen", { namespace: "feed", ids: allIds.slice(windowStart, windowStart + 8) });
  });
  const newIdsAcrossCalls = (await Promise.all(calls)).flatMap((output) => output.data.new_ids);
  assert.equal(newIdsAcrossCalls.length, new Set(newIdsAcrossCalls).size, "an id was returned as new twice");
  const coveredIds = new Set(Array.from({ length: 20 }, (_, index) => allIds.slice((index * 3) % 24, ((index * 3) % 24) + 8)).flat());
  assert.deepEqual(new Set(newIdsAcrossCalls), coveredIds);
  await testStore.cleanup();
});

function runWorkerProcess(storeDirectory, task) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [WORKER_PATH, storeDirectory, JSON.stringify(task)], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    worker.stdout.on("data", (chunk) => (output += chunk));
    worker.on("error", reject);
    worker.on("close", (exitCode) => (exitCode === 0 ? resolve(JSON.parse(output)) : reject(new Error(`worker exited with ${exitCode}`))));
  });
}

test("separate OS processes: counters and filter_unseen stay exact", async () => {
  const testStore = await createTestStore();
  const workerCount = 4;
  const ids = Array.from({ length: 50 }, (_, index) => `p-${index}`);
  const workerResults = await Promise.all(
    Array.from({ length: workerCount }, () => runWorkerProcess(testStore.storeDirectory, { increments: 15, ids })),
  );
  const runOperation = createTestRunner(testStore);
  assert.equal((await runOperation("get", { namespace: "proc", key: "count" })).data.value, workerCount * 15);
  const newIdsAcrossProcesses = workerResults.flatMap((result) => result.newIds);
  assert.equal(newIdsAcrossProcesses.length, ids.length);
  assert.deepEqual(new Set(newIdsAcrossProcesses), new Set(ids));
  assert.deepEqual(await readdir(testStore.storeDirectory), ["proc.json"]);
  await testStore.cleanup();
});
