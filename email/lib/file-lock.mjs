/**
 * Cross-process mutual exclusion through a lock file created with `wx`
 * (O_CREAT | O_EXCL), so a read-modify-write of a shared file cannot lose
 * updates when several plugin processes use the same state directory.
 *
 * Lock file: `{ "pid": 4242, "token": "<random>", "boot_time_ms": 1763400000000 }`.
 *
 * - After creating the file the holder reads it back and checks its token, so
 *   a lock that was taken over in between is never assumed held.
 * - A lock is stale only when its holder pid no longer exists, or the file
 *   predates this boot (pids are reused across reboots). A takeover removes the
 *   file only if its identity (inode + mtime) is unchanged since it was judged
 *   stale, so a fresh lock created meanwhile is left alone.
 * - Release removes the file only while it still carries the holder's token.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { uptime } from "node:os";

const RETRY_DELAY_MS = 20;
// A holder writes its content right after creating the file; an empty or unparseable lock older than this is debris.
const UNREADABLE_LOCK_GRACE_MS = 5000;
// os.uptime() has whole-second resolution; allow some slack before calling a lock older than the boot.
const BOOT_TIME_SLACK_MS = 5000;

/**
 * Runs `work` while holding the lock file.
 *
 * @param lockFilePath - Path of the lock file; its directory must exist (string)
 * @param work - `async () => result` (function)
 * @param options.timeoutMs - How long to wait for a live holder (number)
 * @param options.onTimeout - `() => Error` thrown when the wait times out (function)
 * @returns The result of `work` (Promise<any>)
 * @throws The `onTimeout` error, or any file system error other than EEXIST/ENOENT
 *
 * @example
 * await withFileLock(`${stateFilePath}.lock`, () => updateCounter(), { timeoutMs: 10000, onTimeout: () => new Error("busy") });
 */
export async function withFileLock(lockFilePath, work, { timeoutMs, onTimeout }) {
  const lockToken = await acquireLock(lockFilePath, { deadlineMs: Date.now() + timeoutMs, onTimeout });
  try {
    return await work();
  } finally {
    await releaseLock(lockFilePath, lockToken);
  }
}

async function acquireLock(lockFilePath, { deadlineMs, onTimeout }) {
  for (;;) {
    const lockToken = await tryCreateLock(lockFilePath);
    if (lockToken) return lockToken;
    await removeLockIfStale(lockFilePath);
    if (Date.now() >= deadlineMs) throw onTimeout();
    await waitBeforeRetry();
  }
}

// Returns the token when this process now holds the lock, or null when someone else does.
async function tryCreateLock(lockFilePath) {
  const lockToken = randomBytes(16).toString("hex");
  const lockContent = JSON.stringify({ pid: process.pid, token: lockToken, boot_time_ms: readBootTimeMs() });
  try {
    await writeFile(lockFilePath, lockContent, { flag: "wx", mode: 0o600 });
  } catch (createError) {
    if (createError.code === "EEXIST") return null;
    throw createError;
  }
  const savedLock = await readLock(lockFilePath);
  return savedLock?.token === lockToken ? lockToken : null;
}

async function removeLockIfStale(lockFilePath) {
  const judgedIdentity = await statLock(lockFilePath);
  if (!judgedIdentity) return;
  const savedLock = await readLock(lockFilePath);
  if (!isStaleLock(savedLock, judgedIdentity)) return;
  const currentIdentity = await statLock(lockFilePath);
  if (!currentIdentity || currentIdentity.ino !== judgedIdentity.ino || currentIdentity.mtimeMs !== judgedIdentity.mtimeMs) return;
  await unlink(lockFilePath).catch(ignoreMissingFile);
}

function isStaleLock(savedLock, lockIdentity) {
  if (lockIdentity.mtimeMs < readBootTimeMs() - BOOT_TIME_SLACK_MS) return true;
  if (!savedLock) return Date.now() - lockIdentity.mtimeMs > UNREADABLE_LOCK_GRACE_MS;
  return !isProcessAlive(savedLock.pid);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (signalError) {
    // EPERM: the process exists but belongs to another user.
    return signalError.code === "EPERM";
  }
}

async function releaseLock(lockFilePath, lockToken) {
  const savedLock = await readLock(lockFilePath);
  if (savedLock?.token !== lockToken) return;
  await unlink(lockFilePath).catch(ignoreMissingFile);
}

async function readLock(lockFilePath) {
  try {
    const savedLock = JSON.parse(await readFile(lockFilePath, "utf8"));
    return savedLock && typeof savedLock === "object" && typeof savedLock.token === "string" ? savedLock : null;
  } catch {
    return null;
  }
}

async function statLock(lockFilePath) {
  try {
    const lockStats = await stat(lockFilePath);
    return { ino: lockStats.ino, mtimeMs: lockStats.mtimeMs };
  } catch (statError) {
    ignoreMissingFile(statError);
    return null;
  }
}

function ignoreMissingFile(fileError) {
  if (fileError.code !== "ENOENT") throw fileError;
}

function readBootTimeMs() {
  return Date.now() - uptime() * 1000;
}

function waitBeforeRetry() {
  const jitterMs = Math.floor(Math.random() * RETRY_DELAY_MS);
  return new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_DELAY_MS + jitterMs));
}
