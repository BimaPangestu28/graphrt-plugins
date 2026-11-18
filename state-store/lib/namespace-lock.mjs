/**
 * Cross-process lock for one namespace file.
 *
 * A lock is a file holding `{pid, token, hostname, created_at, boot_time}`, created with an exclusive create
 * (`open(path, "wx")`), so only one process can create it. After creating it the owner re-reads it and
 * checks its random token.
 *
 * A lock is stale when it was created before this host's last boot (pids are reused after a reboot, and the
 * host may have been renamed), when its pid is dead (same host), or, when it cannot be parsed, once its
 * mtime is older than STALE_AFTER_MS. Taking over a stale lock must never produce two holders, even when
 * several processes notice the same stale lock at once. So a takeover first claims a guard file named after
 * the stale lock's content hash (`<lock>.break-<hash>`), again by exclusive create. Only the guard's owner may
 * replace the lock: it re-reads the lock and replaces it only if it is still the very file it saw as stale
 * (same inode, mtime, size and content) and is still stale. Content alone is not enough: every empty or
 * half-written lock has the same content, and a fresh lock created after the stale one was released may be
 * empty for a moment. A stale file can still change in one case: a creator stalled for over STALE_AFTER_MS
 * between its exclusive create and its write. It then fails its own token check, or later its assertHeld
 * before writing data, so no data is written under a lost lock. A guard left by a breaker that crashed is
 * itself stale and is taken over the same way (the same identity checks apply), up to MAX_TAKEOVER_DEPTH
 * levels. After acquiring, the holder removes old leftover guards and temp lock files of this lock.
 *
 * Limits: local disks only. A lock from another host created during this boot is never broken (on a local
 * disk it cannot exist, so refusing is the conservative choice); a lock created before this boot is broken
 * whatever its hostname, which is wrong on a shared network disk (unsupported).
 */
import { createHash, randomBytes } from "node:crypto";
import * as nodeFileSystem from "node:fs/promises";
import { hostname as readHostname, uptime as readUptimeSeconds } from "node:os";
import { basename, dirname, join } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";

const DEFAULT_LOCK_TIMEOUT_MS = 10000;
// A lock file that cannot be parsed may be one still being written: stale only after this long. Leftover
// guards and temp lock files older than this are removed too.
const STALE_AFTER_MS = 30000;
const MAX_TAKEOVER_DEPTH = 3;
const FIRST_RETRY_DELAY_MS = 5;
const MAX_RETRY_DELAY_MS = 100;
// Boot times are estimated (now - uptime) and may wobble by a few seconds between processes.
const BOOT_TIME_MARGIN_MS = 60000;

/**
 * Creates a locker. Every dependency is injectable so tests can fake pids, liveness and timing.
 *
 * @param options.fileSystem - `node:fs/promises`-compatible module (object, optional)
 * @param options.pid - This process's pid (number, default process.pid)
 * @param options.hostname - This host's name (string, default os.hostname())
 * @param options.isProcessAlive - `(pid) => boolean` (function, optional)
 * @param options.sleep - `(delayMs) => Promise` (function, optional)
 * @param options.now - `() => epoch ms` (function, default Date.now)
 * @param options.lockTimeoutMs - How long acquire waits for a live holder (number, default 10000)
 * @param options.bootTimeMs - When this host booted, epoch ms (number, default now - os.uptime())
 * @param options.logWarning - `(message) => void` for problems that do not fail an acquire (function, default stderr)
 * @returns `{acquire(lockPath, signal) => Promise<LockHandle>, describeTakeoverGuardPath(lockPath, staleContent)}`
 *
 * @example
 * const handle = await createNamespaceLocker().acquire("/data/orders.lock", signal);
 * try { await handle.assertHeld(); } finally { await handle.release(); }
 */
export function createNamespaceLocker(options = {}) {
  const settings = {
    fileSystem: options.fileSystem ?? nodeFileSystem,
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? readHostname(),
    isProcessAlive: options.isProcessAlive ?? checkProcessAlive,
    sleep: options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    now: options.now ?? Date.now,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    bootTimeMs: options.bootTimeMs ?? Date.now() - readUptimeSeconds() * 1000,
    logWarning: options.logWarning ?? ((message) => console.error(`state-store: ${message}`)),
    activeTokens: new Set(),
  };
  return {
    acquire: (lockPath, signal) => acquireLock(settings, lockPath, signal),
    describeTakeoverGuardPath,
  };
}

/**
 * Path of the guard that must be owned to replace a stale lock (or stale guard) with this content.
 *
 * @param lockedPath - Lock or guard path (string)
 * @param staleContent - Its stale content (string)
 * @returns Guard path (string)
 */
export function describeTakeoverGuardPath(lockedPath, staleContent) {
  return `${lockedPath}.break-${createHash("sha256").update(staleContent).digest("hex").slice(0, 16)}`;
}

async function acquireLock(settings, lockPath, signal) {
  const deadline = settings.now() + settings.lockTimeoutMs;
  let retryDelayMs = FIRST_RETRY_DELAY_MS;
  for (;;) {
    throwIfAborted(signal, lockPath);
    const record = createLockRecord(settings);
    if (await claimPath(settings, lockPath, record, 0)) {
      await removeLeftoverLockFiles(settings, lockPath);
      return createLockHandle(settings, lockPath, record);
    }
    if (settings.now() >= deadline) throw await createTimeoutError(settings, lockPath);
    await settings.sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
  }
}

// Returns true when `targetPath` now holds `record`; false when someone else owns it (try again later).
async function claimPath(settings, targetPath, record, depth) {
  if (await createExclusively(settings, targetPath, record)) return verifyContent(settings, targetPath, record);
  const observed = await readLockFile(settings, targetPath);
  if (!observed?.isSettled || !isStale(settings, observed)) return false;
  if (depth >= MAX_TAKEOVER_DEPTH) {
    throw new PluginError(`Could not take over the stale lock ${targetPath}: too many crashed takeovers. Delete ${targetPath}* if no graphrt run is using it`, {
      kind: "storage_error",
    });
  }
  return takeOverStalePath(settings, targetPath, observed, record, depth);
}

async function takeOverStalePath(settings, targetPath, staleObservation, record, depth) {
  const guardPath = describeTakeoverGuardPath(targetPath, staleObservation.content);
  const guardRecord = createLockRecord(settings);
  if (!(await claimPath(settings, guardPath, guardRecord, depth + 1))) return false;
  try {
    if (!isSameStaleFile(settings, staleObservation, await readLockFile(settings, targetPath))) return false;
    await replaceAtomically(settings, targetPath, record);
    return verifyContent(settings, targetPath, record);
  } finally {
    await removeIfContentMatches(settings, guardPath, guardRecord);
  }
}

// Guards left by crashed breakers (or named after lock contents that are long gone) and temp locks of
// crashed takeovers are never needed again. While we hold the lock no takeover of it can be in progress, so
// removing them is safe; the age check only spares files of a takeover of an older lock that is just finishing.
async function removeLeftoverLockFiles(settings, lockPath) {
  const directoryPath = dirname(lockPath);
  let fileNames;
  try {
    fileNames = await settings.fileSystem.readdir(directoryPath);
  } catch (readError) {
    settings.logWarning(`could not list ${directoryPath} to remove leftover lock files: ${readError.code ?? readError.message}`);
    return;
  }
  const leftoverPattern = createLeftoverLockFilePattern(basename(lockPath));
  for (const fileName of fileNames.filter((candidate) => leftoverPattern.test(candidate))) {
    await removeIfOlderThanStaleThreshold(settings, join(directoryPath, fileName));
  }
}

// `<lock>.break-<hash>[.break-<hash>…]`, optionally followed by `.<token>.tmp`, or `<lock>.<token>.tmp`.
function createLeftoverLockFilePattern(lockFileName) {
  const escapedName = lockFileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedName}((\\.break-[0-9a-f]{16})+(\\.[0-9a-f]{32}\\.tmp)?|\\.[0-9a-f]{32}\\.tmp)$`);
}

async function removeIfOlderThanStaleThreshold(settings, filePath) {
  try {
    const { mtimeMs } = await settings.fileSystem.stat(filePath);
    if (settings.now() - mtimeMs > STALE_AFTER_MS) await settings.fileSystem.rm(filePath, { force: true });
  } catch (removeError) {
    if (removeError.code !== "ENOENT") settings.logWarning(`could not remove the leftover lock file ${filePath}: ${removeError.code ?? removeError.message}`);
  }
}

function createLockRecord(settings) {
  const token = randomBytes(16).toString("hex");
  const content = JSON.stringify({
    pid: settings.pid,
    token,
    hostname: settings.hostname,
    created_at: new Date(settings.now()).toISOString(),
    boot_time: new Date(settings.bootTimeMs).toISOString(),
  });
  return { token, content };
}

function createLockHandle(settings, lockPath, record) {
  settings.activeTokens.add(record.token);
  return {
    token: record.token,
    assertHeld: async () => {
      if (await verifyContent(settings, lockPath, record)) return;
      throw new PluginError(`Lost the lock ${lockPath} to another process before writing; nothing was written, retry`, {
        kind: "storage_error",
        retryable: true,
      });
    },
    release: async () => {
      settings.activeTokens.delete(record.token);
      await removeIfContentMatches(settings, lockPath, record);
    },
  };
}

async function createExclusively(settings, targetPath, record) {
  let lockFile;
  try {
    lockFile = await settings.fileSystem.open(targetPath, "wx", 0o600);
  } catch (openError) {
    if (openError.code === "EEXIST") return false;
    throw storageError(`Could not create the lock ${targetPath}`, openError);
  }
  try {
    await writeAndSync(lockFile, record.content);
  } catch (writeError) {
    await settings.fileSystem.rm(targetPath, { force: true });
    throw storageError(`Could not write the lock ${targetPath}`, writeError);
  }
  return true;
}

async function writeAndSync(fileHandle, content) {
  try {
    await fileHandle.writeFile(content);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}

// Writes a complete temp file and renames it over the target, so readers never see a partial lock.
async function replaceAtomically(settings, targetPath, record) {
  const temporaryPath = `${targetPath}.${record.token}.tmp`;
  try {
    await writeAndSync(await settings.fileSystem.open(temporaryPath, "wx", 0o600), record.content);
    await settings.fileSystem.rename(temporaryPath, targetPath);
  } catch (renameError) {
    await settings.fileSystem.rm(temporaryPath, { force: true });
    throw storageError(`Could not take over the stale lock ${targetPath}`, renameError);
  }
}

async function verifyContent(settings, targetPath, record) {
  return (await readLockFile(settings, targetPath))?.content === record.content;
}

async function removeIfContentMatches(settings, targetPath, record) {
  // Only a breaker of *our* record could replace it, and that needs our pid dead or a reboot: the
  // check-then-remove is safe.
  if (await verifyContent(settings, targetPath, record)) await settings.fileSystem.rm(targetPath, { force: true });
}

// Equal content is not enough: every empty (or half-written) lock has the same content. The file must be the
// very one observed as stale (same inode, mtime and size) and must still be stale now.
function isSameStaleFile(settings, staleObservation, current) {
  if (!current?.isSettled || current.identity !== staleObservation.identity) return false;
  return current.content === staleObservation.content && isStale(settings, current);
}

// Stats before and after the read: `isSettled` is false when the file changed (or was replaced) meanwhile,
// so `content` and `identity` always describe the same file version when it is true.
async function readLockFile(settings, targetPath) {
  try {
    const statsBefore = await settings.fileSystem.stat(targetPath);
    const content = await settings.fileSystem.readFile(targetPath, "utf8");
    const statsAfter = await settings.fileSystem.stat(targetPath);
    const identity = describeFileIdentity(statsAfter);
    return { content, identity, mtimeMs: statsAfter.mtimeMs, isSettled: identity === describeFileIdentity(statsBefore), holder: parseLockRecord(content) };
  } catch (readError) {
    if (readError.code === "ENOENT") return null;
    throw storageError(`Could not read the lock ${targetPath}`, readError);
  }
}

function describeFileIdentity(fileStats) {
  return `${fileStats.dev}:${fileStats.ino}:${fileStats.mtimeMs}:${fileStats.size}`;
}

function parseLockRecord(content) {
  try {
    const parsed = JSON.parse(content);
    return Number.isInteger(parsed?.pid) && typeof parsed.token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function isStale(settings, observed) {
  const { holder } = observed;
  if (!holder) return settings.now() - observed.mtimeMs > STALE_AFTER_MS;
  if (settings.activeTokens.has(holder.token)) return false;
  if (isFromEarlierBoot(settings, holder)) return true;
  if (holder.hostname && holder.hostname !== settings.hostname) return false;
  if (holder.pid === settings.pid) return true;
  return !settings.isProcessAlive(holder.pid);
}

// A lock from before this host's last boot is dead whatever its pid (pids are reused after a reboot) and
// whatever its hostname (the host may have been renamed). On a local disk only this host writes locks, so the
// creation time is checked for any hostname. The recorded boot time compares only on this host: another host's
// boot time says nothing about ours.
function isFromEarlierBoot(settings, holder) {
  const earliestThisBootMs = settings.bootTimeMs - BOOT_TIME_MARGIN_MS;
  if (Date.parse(holder.created_at) < earliestThisBootMs) return true;
  return holder.hostname === settings.hostname && Date.parse(holder.boot_time) < earliestThisBootMs;
}

async function createTimeoutError(settings, lockPath) {
  const holder = (await readLockFile(settings, lockPath))?.holder;
  const holderText = holder ? `pid ${holder.pid} on ${holder.hostname ?? "unknown host"}` : "another process";
  return new PluginError(
    `Timed out after ${settings.lockTimeoutMs} ms waiting for the lock ${lockPath}, held by ${holderText}. If no graphrt run is using it, delete the lock file`,
    { kind: "lock_timeout", retryable: true },
  );
}

function throwIfAborted(signal, lockPath) {
  if (signal?.aborted) throw new PluginError(`Cancelled while waiting for the lock ${lockPath}`, { kind: "cancelled" });
}

function storageError(message, cause) {
  return new PluginError(`${message}: ${cause.code ?? cause.message}`, { kind: "storage_error" });
}

function checkProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (signalError) {
    return signalError.code === "EPERM";
  }
}
