import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import * as realFileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNamespaceLocker } from "../lib/namespace-lock.mjs";

const DEAD_PID = 999001;

async function createTemporaryDirectory() {
  return mkdtemp(join(tmpdir(), "state-store-lock-"));
}

function createTestLocker(pid, overrides = {}) {
  return createNamespaceLocker({
    pid,
    hostname: "test-host",
    isProcessAlive: (candidatePid) => candidatePid !== DEAD_PID,
    sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 2))),
    lockTimeoutMs: 2000,
    ...overrides,
  });
}

function staleLockRecord(token = "stale-token") {
  return JSON.stringify({ pid: DEAD_PID, token, hostname: "test-host", created_at: "2026-01-01T00:00:00.000Z" });
}

// Wraps fs so every read of `pathSuffix` waits until `participantCount` readers arrived:
// forces the worst interleaving, where all contenders see the same stale lock at once.
function createBarrierFileSystem(pathSuffix, participantCount) {
  let waiting = [];
  let released = false;
  return {
    ...realFileSystem,
    readFile: async (filePath, ...rest) => {
      const content = await realFileSystem.readFile(filePath, ...rest);
      if (released || !String(filePath).endsWith(pathSuffix)) return content;
      await new Promise((resolve) => {
        waiting.push(resolve);
        if (waiting.length === participantCount) {
          released = true;
          waiting.forEach((resume) => resume());
          waiting = [];
        }
      });
      return content;
    },
  };
}

test("acquires a free lock, writes pid and token, and removes it on release", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const handle = await createTestLocker(4242).acquire(lockPath);
  const record = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(record.pid, 4242);
  assert.match(record.token, /^[0-9a-f]{32}$/);
  await handle.assertHeld();
  await handle.release();
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true });
});

test("a second process waits for a live holder and gets the lock after release", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const firstHandle = await createTestLocker(1001).acquire(lockPath);
  const order = [];
  const secondAcquire = createTestLocker(1002).acquire(lockPath).then((handle) => {
    order.push("second acquired");
    return handle;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  order.push("first releases");
  await firstHandle.release();
  const secondHandle = await secondAcquire;
  assert.deepEqual(order, ["first releases", "second acquired"]);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 1002);
  await secondHandle.release();
  await rm(directory, { recursive: true });
});

test("times out with a retryable lock_timeout naming the holder", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const holder = await createTestLocker(1001).acquire(lockPath);
  await assert.rejects(createTestLocker(1002, { lockTimeoutMs: 40 }).acquire(lockPath), (error) => {
    assert.equal(error.kind, "lock_timeout");
    assert.equal(error.retryable, true);
    assert.match(error.message, /pid 1001/);
    return true;
  });
  await holder.release();
  await rm(directory, { recursive: true });
});

test("stops waiting when the signal aborts", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const holder = await createTestLocker(1001).acquire(lockPath);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(createTestLocker(1002).acquire(lockPath, controller.signal), { kind: "cancelled" });
  await holder.release();
  await rm(directory, { recursive: true });
});

test("takes over a lock whose pid is dead", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  await writeFile(lockPath, staleLockRecord());
  const handle = await createTestLocker(1001).acquire(lockPath);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 1001);
  await handle.release();
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true });
});

test("concurrent takeovers of one stale lock yield exactly one holder at a time", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  await writeFile(lockPath, staleLockRecord());
  const contenderCount = 5;
  const fileSystem = createBarrierFileSystem("demo.lock", contenderCount);
  let currentHolders = 0;
  let maximumHolders = 0;
  const contenders = Array.from({ length: contenderCount }, (_, index) =>
    createTestLocker(2000 + index, { fileSystem }).acquire(lockPath).then(async (handle) => {
      currentHolders += 1;
      maximumHolders = Math.max(maximumHolders, currentHolders);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await handle.assertHeld();
      currentHolders -= 1;
      await handle.release();
    }),
  );
  await Promise.all(contenders);
  assert.equal(maximumHolders, 1);
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true });
});

test("a contender that saw the stale lock late never replaces the new holder's lock", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  await writeFile(lockPath, staleLockRecord());
  let markFirstHolderReady;
  const firstHolderReady = new Promise((resolve) => (markFirstHolderReady = resolve));
  let delayedOnce = false;
  // The late contender reads the stale lock, then stalls until the first contender has taken over.
  const lateFileSystem = {
    ...realFileSystem,
    readFile: async (filePath, ...rest) => {
      const content = await realFileSystem.readFile(filePath, ...rest);
      if (!delayedOnce && String(filePath) === lockPath) {
        delayedOnce = true;
        await firstHolderReady;
      }
      return content;
    },
  };
  const lateAcquire = createTestLocker(3002, { fileSystem: lateFileSystem }).acquire(lockPath);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const firstHandle = await createTestLocker(3001).acquire(lockPath);
  markFirstHolderReady();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await firstHandle.assertHeld();
  await firstHandle.release();
  await (await lateAcquire).release();
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true });
});

test("breaks a stale takeover guard left by a breaker that crashed", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const staleRecord = staleLockRecord("stale-a");
  await writeFile(lockPath, staleRecord);
  const locker = createTestLocker(1001);
  await writeFile(locker.describeTakeoverGuardPath(lockPath, staleRecord), staleLockRecord("crashed-breaker"));
  const handle = await locker.acquire(lockPath);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 1001);
  await handle.release();
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true });
});

test("a lock from this pid that this process does not hold is stale (pid reuse)", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 1001, token: "old-run", hostname: "test-host" }));
  const handle = await createTestLocker(1001).acquire(lockPath);
  assert.notEqual(JSON.parse(await readFile(lockPath, "utf8")).token, "old-run");
  await handle.release();
  await rm(directory, { recursive: true });
});

test("never breaks a lock from another host", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  await writeFile(lockPath, JSON.stringify({ pid: DEAD_PID, token: "remote", hostname: "other-host" }));
  await assert.rejects(createTestLocker(1001, { lockTimeoutMs: 30 }).acquire(lockPath), (error) => {
    assert.equal(error.kind, "lock_timeout");
    assert.match(error.message, /other-host/);
    return true;
  });
  await rm(directory, { recursive: true });
});

test("never breaks a lock another host created during this boot, even with an old boot time", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const bootTimeMs = Date.now() - 3600000;
  const remoteRecord = { pid: DEAD_PID, token: "remote", hostname: "other-host", created_at: new Date().toISOString(), boot_time: new Date(bootTimeMs - 86400000).toISOString() };
  await writeFile(lockPath, JSON.stringify(remoteRecord));
  await assert.rejects(createTestLocker(1001, { lockTimeoutMs: 30, bootTimeMs }).acquire(lockPath), { kind: "lock_timeout" });
  await rm(directory, { recursive: true });
});

test("records this boot's time in the lock", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const bootTimeMs = Date.parse("2026-11-18T08:00:00.000Z");
  const handle = await createTestLocker(1001, { bootTimeMs }).acquire(lockPath);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).boot_time, "2026-11-18T08:00:00.000Z");
  await handle.release();
  await rm(directory, { recursive: true });
});

test("a lock from before the last reboot is stale even when its pid is alive or the hostname changed", async (t) => {
  const bootTimeMs = Date.now() - 3600000;
  const previousBoot = new Date(bootTimeMs - 86400000).toISOString();
  const cases = [
    ["created before boot, pid reused by a live process", { pid: 4321, token: "t", hostname: "test-host", created_at: new Date(bootTimeMs - 600000).toISOString() }],
    ["created before boot, hostname changed since", { pid: 4321, token: "t", hostname: "old-name", created_at: new Date(bootTimeMs - 600000).toISOString() }],
    ["created just before boot (within the margin), older boot time recorded", { pid: 4321, token: "t", hostname: "test-host", created_at: new Date(bootTimeMs - 1000).toISOString(), boot_time: previousBoot }],
  ];
  for (const [caseName, lockRecord] of cases) {
    await t.test(caseName, async () => {
      const directory = await createTemporaryDirectory();
      const lockPath = join(directory, "demo.lock");
      await writeFile(lockPath, JSON.stringify(lockRecord));
      const handle = await createTestLocker(1001, { lockTimeoutMs: 200, bootTimeMs, isProcessAlive: () => true }).acquire(lockPath);
      assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, 1001);
      await handle.release();
      await rm(directory, { recursive: true });
    });
  }
});

test("a live lock from this boot is not broken", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const bootTimeMs = Date.now() - 3600000;
  const liveRecord = { pid: 4321, token: "t", hostname: "test-host", created_at: new Date().toISOString(), boot_time: new Date(bootTimeMs).toISOString() };
  await writeFile(lockPath, JSON.stringify(liveRecord));
  await assert.rejects(createTestLocker(1001, { lockTimeoutMs: 30, bootTimeMs, isProcessAlive: () => true }).acquire(lockPath), { kind: "lock_timeout" });
  await rm(directory, { recursive: true });
});

test("an unreadable lock is stale only after the grace period", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  await writeFile(lockPath, "");
  await assert.rejects(createTestLocker(1001, { lockTimeoutMs: 30 }).acquire(lockPath), { kind: "lock_timeout" });
  const laterLocker = createTestLocker(1001, { now: () => Date.now() + 120000 });
  const handle = await laterLocker.acquire(lockPath);
  await handle.release();
  await rm(directory, { recursive: true });
});

test("assertHeld fails when the lock was replaced", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const handle = await createTestLocker(1001).acquire(lockPath);
  await writeFile(lockPath, staleLockRecord("intruder"));
  await assert.rejects(handle.assertHeld(), (error) => error.kind === "storage_error" && error.retryable === true);
  await handle.release();
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "intruder");
  await rm(directory, { recursive: true });
});

test("after acquiring, removes this lock's leftover guards and temp files older than the stale threshold", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  const oldTime = new Date(Date.now() - 120000);
  const oldLeftovers = [
    "demo.lock.break-0123456789abcdef",
    "demo.lock.break-0123456789abcdef.break-fedcba9876543210",
    `demo.lock.${"a".repeat(32)}.tmp`,
    `demo.lock.break-0123456789abcdef.${"b".repeat(32)}.tmp`,
  ];
  const keptFiles = ["demo.lock.break-1111111111111111", "other.lock.break-0123456789abcdef", "demo.lock.notes"];
  for (const fileName of [...oldLeftovers, ...keptFiles]) await writeFile(join(directory, fileName), "");
  for (const fileName of [...oldLeftovers, ...keptFiles.slice(1)]) await utimes(join(directory, fileName), oldTime, oldTime);
  const handle = await createTestLocker(1001).acquire(lockPath);
  assert.deepEqual((await readdir(directory)).sort(), ["demo.lock", ...keptFiles].sort());
  await handle.release();
  await rm(directory, { recursive: true });
});

test("a failure to list leftover lock files is logged, and the lock is still acquired", async () => {
  const directory = await createTemporaryDirectory();
  const warnings = [];
  const fileSystem = { ...realFileSystem, readdir: async () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) };
  const handle = await createTestLocker(1001, { fileSystem, logWarning: (message) => warnings.push(message) }).acquire(join(directory, "demo.lock"));
  assert.match(warnings.join("\n"), /EACCES/);
  await handle.release();
  await rm(directory, { recursive: true });
});

// Wraps fs so the lock file's first write (after the exclusive create) waits for `writeGate`.
function createStallingWriteFileSystem(lockPath, writeGate, onLockOpened) {
  return {
    ...realFileSystem,
    open: async (filePath, ...rest) => {
      const fileHandle = await realFileSystem.open(filePath, ...rest);
      if (filePath !== lockPath) return fileHandle;
      onLockOpened();
      return {
        writeFile: async (content) => {
          await writeGate;
          return fileHandle.writeFile(content);
        },
        sync: () => fileHandle.sync(),
        close: () => fileHandle.close(),
      };
    },
  };
}

// Reproduces the ABA race on empty locks: the breaker sees an old empty (stale) lock and wins its guard;
// meanwhile that lock is released and another process creates a fresh lock that is still empty (it stalls
// before writing). Every empty lock has the same content, so a content-only re-check would let the breaker
// rename over the fresh lock: two holders.
test("a takeover never replaces a fresh empty lock that has the same content as the stale one (ABA)", async () => {
  const directory = await createTemporaryDirectory();
  const lockPath = join(directory, "demo.lock");
  await writeFile(lockPath, "");
  const oldTime = new Date(Date.now() - 120000);
  await utimes(lockPath, oldTime, oldTime);
  let releaseWriteGate;
  const writeGate = new Promise((resolve) => (releaseWriteGate = resolve));
  let markFreshLockOpened;
  const freshLockOpened = new Promise((resolve) => (markFreshLockOpened = resolve));
  const freshLocker = createTestLocker(3003, { fileSystem: createStallingWriteFileSystem(lockPath, writeGate, markFreshLockOpened) });
  let freshAcquire;
  let lockReadCount = 0;
  const breakerFileSystem = {
    ...realFileSystem,
    readFile: async (filePath, ...rest) => {
      if (filePath === lockPath && ++lockReadCount === 2) {
        await rm(lockPath);
        freshAcquire = freshLocker.acquire(lockPath);
        await freshLockOpened;
        setTimeout(releaseWriteGate, 20);
      }
      return realFileSystem.readFile(filePath, ...rest);
    },
    rename: async (fromPath, toPath) => {
      if (toPath === lockPath) {
        releaseWriteGate();
        await freshAcquire;
      }
      return realFileSystem.rename(fromPath, toPath);
    },
  };
  let breakerAcquired = false;
  const breakerAcquire = createTestLocker(3002, { fileSystem: breakerFileSystem }).acquire(lockPath).then((handle) => {
    breakerAcquired = true;
    return handle;
  });
  while (!freshAcquire) await new Promise((resolve) => setTimeout(resolve, 1));
  const freshHandle = await freshAcquire;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(breakerAcquired, false, "the breaker acquired while the fresh holder held the lock");
  await freshHandle.assertHeld();
  await freshHandle.release();
  await (await breakerAcquire).release();
  assert.deepEqual(await readdir(directory), []);
  await rm(directory, { recursive: true });
});
