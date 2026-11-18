import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import * as fileSystemPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSession } from "../lib/browser-session.mjs";
import { PROFILE_LOCK_FILE_NAME, acquireProfileLock } from "../lib/profile-lock.mjs";
import { createFakeLauncher, createFakeTimers } from "./helpers.mjs";

async function withProfile(testBody) {
  const profileDirectory = await mkdtemp(join(tmpdir(), "wa-lock-"));
  try {
    await testBody(profileDirectory, join(profileDirectory, PROFILE_LOCK_FILE_NAME));
  } finally {
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

async function readLockPid(lockPath) {
  return Number.parseInt(await readFile(lockPath, "utf8"), 10);
}

test("the lock holds this process's pid plus a per-launch token and release removes it", () =>
  withProfile(async (profileDirectory, lockPath) => {
    const release = await acquireProfileLock(profileDirectory);
    assert.match(await readFile(lockPath, "utf8"), new RegExp(`^${process.pid} \\S+$`));
    await release();
    assert.equal(existsSync(lockPath), false);
  }));

test("a profile locked by another live process is refused with browser_error", () =>
  withProfile(async (profileDirectory, lockPath) => {
    await writeFile(lockPath, "4242");
    await assert.rejects(acquireProfileLock(profileDirectory, { isProcessAlive: (pid) => pid === 4242 }), (error) => {
      assert.equal(error.kind, "browser_error");
      assert.match(error.message, /in use by another process \(pid 4242\)/);
      return true;
    });
  }));

test("a lock left by a dead process is taken over", () =>
  withProfile(async (profileDirectory, lockPath) => {
    await writeFile(lockPath, "4242 old-token");
    await acquireProfileLock(profileDirectory, { isProcessAlive: () => false });
    assert.equal(await readLockPid(lockPath), process.pid);
  }));

test("a late release from an earlier launch does not delete the current launch's lock", () =>
  withProfile(async (profileDirectory, lockPath) => {
    const releaseEarlierLaunch = await acquireProfileLock(profileDirectory);
    await releaseEarlierLaunch();
    const releaseCurrentLaunch = await acquireProfileLock(profileDirectory);
    await releaseEarlierLaunch();
    assert.equal(existsSync(lockPath), true, "the current launch still holds the profile");
    await releaseCurrentLaunch();
    assert.equal(existsSync(lockPath), false);
  }));

test("a stale lock that another process takes over mid-check is not deleted", () =>
  withProfile(async (profileDirectory, lockPath) => {
    await writeFile(lockPath, "4242 stale-token");
    let hasReplacedLock = false;
    const isProcessAlive = (pid) => {
      if (!hasReplacedLock) {
        // Another process wins the takeover between our liveness check and our removal.
        hasReplacedLock = true;
        unlinkSync(lockPath);
        writeFileSync(lockPath, "5555 other-token");
        return false;
      }
      return pid === 5555;
    };
    await assert.rejects(acquireProfileLock(profileDirectory, { isProcessAlive }), { kind: "browser_error" });
    assert.equal(await readFile(lockPath, "utf8"), "5555 other-token");
  }));

test("acquire fails when the lock read back after creation holds another token", () =>
  withProfile(async (profileDirectory, lockPath) => {
    const clobberingFileSystem = {
      ...fileSystemPromises,
      // Simulates another process overwriting the lock right after we created it.
      readFile: async () => "5555 other-token",
    };
    await assert.rejects(acquireProfileLock(profileDirectory, { fileSystem: clobberingFileSystem }), { kind: "browser_error" });
    assert.equal(existsSync(lockPath), true, "the other process's lock is not removed");
  }));

test("the session takes the lock on launch, refuses a busy profile, and releases on close", () =>
  withProfile(async (profileDirectory, lockPath) => {
    const launcher = createFakeLauncher();
    const session = createBrowserSession({ profileDirectory, idleTimeoutMs: 1000, launchPersistentContext: launcher, timers: createFakeTimers() });
    await session.run(async () => {});
    assert.equal(await readLockPid(lockPath), process.pid);
    await session.close();
    assert.equal(existsSync(lockPath), false);
    await writeFile(lockPath, String(process.ppid));
    await assert.rejects(session.run(async () => {}), { kind: "browser_error" });
    assert.equal(launcher.launches.length, 1, "no second browser was started on the busy profile");
  }));

test("a late close event from an old context does not release the new context's lock", () =>
  withProfile(async (profileDirectory, lockPath) => {
    const launcher = createFakeLauncher();
    const session = createBrowserSession({ profileDirectory, idleTimeoutMs: 1000, launchPersistentContext: launcher, timers: createFakeTimers() });
    await session.run(async () => {});
    await session.run(async () => {}, { headed: true });
    assert.equal(launcher.contexts.length, 2);
    launcher.contexts[0].emit("close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(existsSync(lockPath), true, "the headed context still holds the profile");
    assert.equal(session.isOpen(), true);
  }));
