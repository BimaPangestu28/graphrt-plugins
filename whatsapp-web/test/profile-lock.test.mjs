import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

test("the lock holds this process's pid and release removes it", () =>
  withProfile(async (profileDirectory, lockPath) => {
    const release = await acquireProfileLock(profileDirectory);
    assert.equal(await readFile(lockPath, "utf8"), String(process.pid));
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
    await writeFile(lockPath, "4242");
    await acquireProfileLock(profileDirectory, { isProcessAlive: () => false });
    assert.equal(await readFile(lockPath, "utf8"), String(process.pid));
  }));

test("the session takes the lock on launch, refuses a busy profile, and releases on close", () =>
  withProfile(async (profileDirectory, lockPath) => {
    const launcher = createFakeLauncher();
    const session = createBrowserSession({ profileDirectory, idleTimeoutMs: 1000, launchPersistentContext: launcher, timers: createFakeTimers() });
    await session.run(async () => {});
    assert.equal(await readFile(lockPath, "utf8"), String(process.pid));
    await session.close();
    assert.equal(existsSync(lockPath), false);
    await writeFile(lockPath, String(process.ppid));
    await assert.rejects(session.run(async () => {}), { kind: "browser_error" });
    assert.equal(launcher.launches.length, 1, "no second browser was started on the busy profile");
  }));
