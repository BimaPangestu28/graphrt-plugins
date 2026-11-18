/**
 * A lock file in the profile directory, so two plugin processes never open
 * the same WhatsApp profile at once. Headless Chromium does not enforce this
 * itself (checked live: a second headless launch on a busy profile succeeds),
 * and two writers would corrupt the session store.
 *
 * The file holds `<pid> <token>`, with a fresh random token per acquisition:
 * - release only removes the file while it still holds that acquisition's
 *   token, so a late close of an old browser context cannot delete the lock a
 *   newer context (same pid) took since;
 * - a stale lock (dead pid) is only removed if its identity (inode, mtime and
 *   content) is unchanged since it was judged stale, so a process that took it
 *   over in between keeps it;
 * - after creating the file the token is read back, so a lost race is reported
 *   instead of two processes both believing they hold the profile.
 * A lock written by an older version (pid only) is still understood.
 */
import { randomUUID } from "node:crypto";
import * as nodeFileSystem from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const PROFILE_LOCK_FILE_NAME = "graphrt-whatsapp-web.lock";

const MAX_TAKEOVER_ATTEMPTS = 3;

/**
 * Takes the profile lock for this launch; a lock left by a dead process is replaced.
 *
 * @param profileDirectory - Chromium profile directory (string)
 * @param options - Injectable dependencies for tests (object, optional)
 * @param options.isProcessAlive - `(pid) => boolean` (function)
 * @param options.fileSystem - `{open, readFile, rm, stat}` like `node:fs/promises` (object)
 * @returns `release()` that removes the lock if this launch still holds it (Promise<() => Promise<void>>)
 * @throws PluginError kind `browser_error` - When another live process holds or just took the profile
 */
export async function acquireProfileLock(profileDirectory, { isProcessAlive = checkProcessAlive, fileSystem = nodeFileSystem } = {}) {
  const lock = { path: join(profileDirectory, PROFILE_LOCK_FILE_NAME), token: `${process.pid} ${randomUUID()}`, fileSystem };
  for (let attempt = 1; attempt <= MAX_TAKEOVER_ATTEMPTS; attempt += 1) {
    if (await tryCreateLock(lock)) return verifyLockOwnership(lock, profileDirectory);
    const holder = await readLockIdentity(lock);
    if (!holder) continue; // Released between our create and our read: try again.
    assertHolderGone(holder, lock, { profileDirectory, isProcessAlive });
    await removeLockIfUnchanged(lock, holder);
  }
  throw lockContentionError(profileDirectory);
}

async function tryCreateLock(lock) {
  try {
    const lockFile = await lock.fileSystem.open(lock.path, "wx");
    try {
      await lockFile.writeFile(lock.token);
    } finally {
      await lockFile.close();
    }
    return true;
  } catch (openError) {
    if (openError.code === "EEXIST") return false;
    throw openError;
  }
}

async function verifyLockOwnership(lock, profileDirectory) {
  const lockContent = await lock.fileSystem.readFile(lock.path, "utf8").catch(() => null);
  if (lockContent !== lock.token) throw lockContentionError(profileDirectory);
  return () => releaseLock(lock);
}

// Identity of the current lock file, or null when it no longer exists.
async function readLockIdentity(lock) {
  try {
    const lockStats = await lock.fileSystem.stat(lock.path);
    const content = await lock.fileSystem.readFile(lock.path, "utf8");
    return { inode: lockStats.ino, modifiedAtMs: lockStats.mtimeMs, content, pid: Number.parseInt(content, 10) };
  } catch (readError) {
    if (readError.code === "ENOENT") return null;
    throw readError;
  }
}

function assertHolderGone(holder, lock, { profileDirectory, isProcessAlive }) {
  if (!Number.isInteger(holder.pid) || holder.pid === process.pid || !isProcessAlive(holder.pid)) return;
  throw new PluginError(
    `The WhatsApp Web profile ${profileDirectory} is in use by another process (pid ${holder.pid}); wait for it to finish or stop it. If no other graphrt run uses it, delete ${lock.path}`,
    { kind: "browser_error" },
  );
}

// Removes the stale lock only if nobody replaced it since it was judged stale.
async function removeLockIfUnchanged(lock, staleHolder) {
  const currentHolder = await readLockIdentity(lock);
  if (!currentHolder || !isSameLockIdentity(currentHolder, staleHolder)) return;
  console.error(`[whatsapp-web] taking over a stale profile lock left by pid ${staleHolder.pid || "unknown"}`);
  await lock.fileSystem.rm(lock.path, { force: true });
}

function isSameLockIdentity(firstHolder, secondHolder) {
  return (
    firstHolder.inode === secondHolder.inode &&
    firstHolder.modifiedAtMs === secondHolder.modifiedAtMs &&
    firstHolder.content === secondHolder.content
  );
}

async function releaseLock(lock) {
  const lockContent = await lock.fileSystem.readFile(lock.path, "utf8").catch(() => null);
  if (lockContent === lock.token) await lock.fileSystem.rm(lock.path, { force: true });
}

function lockContentionError(profileDirectory) {
  return new PluginError(`Could not lock the WhatsApp Web profile ${profileDirectory}: another process is taking it over; try again`, {
    kind: "browser_error",
  });
}

function checkProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (signalError) {
    return signalError.code === "EPERM";
  }
}
