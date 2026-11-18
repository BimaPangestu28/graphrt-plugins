/**
 * The state-store client: reads and updates one JSON file per namespace in STATE_STORE_DIR.
 *
 * - Reads take no lock: files are only ever replaced by rename, so a reader sees a whole old or new file.
 * - Updates are read-modify-write under two locks: an in-process queue per namespace, then the
 *   cross-process lock file (namespace-lock.mjs). The new content goes to a temp file, is fsynced and
 *   renamed over the old file, then the directory is fsynced. A crash leaves the old or the new file.
 * - A file that cannot be parsed fails the operation (`state_corrupt`); it is never replaced.
 */
import * as nodeFileSystem from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { CLOCK_JUMP_SUSPECT_AFTER_MS, CLOCK_JUMP_SUSPECT_PURGE_SHARE, MAX_FILE_BYTES, NAMESPACE_PATTERN } from "./limits.mjs";
import { countExpiredSeenIds, createEmptyState, hasStateChanges, parseState, purgeExpired, serializeState } from "./namespace-state.mjs";

export const STATE_STORE_DIR_ENV = "STATE_STORE_DIR";
const STATE_FILE_SUFFIX = ".json";

/**
 * Resolves the store directory from STATE_STORE_DIR (default `~/.graphrt/state-store`; a leading `~/` is expanded).
 *
 * @param environment - Environment variables (object)
 * @param homeDirectory - Home directory (string, default os.homedir())
 * @returns Absolute directory path (string)
 * @throws PluginError kind `invalid_input` - When STATE_STORE_DIR is relative
 */
export function resolveStoreDirectory(environment, homeDirectory = homedir()) {
  const configured = environment?.[STATE_STORE_DIR_ENV]?.trim();
  if (!configured) return join(homeDirectory, ".graphrt", "state-store");
  const expanded = configured === "~" || configured.startsWith("~/") ? join(homeDirectory, configured.slice(1)) : configured;
  if (!isAbsolute(expanded)) {
    throw new PluginError(`${STATE_STORE_DIR_ENV} must be an absolute path, got ${JSON.stringify(configured)}`, { kind: "invalid_input" });
  }
  return expanded;
}

/**
 * Creates a client bound to one store directory.
 *
 * @param environment - Environment variables (object)
 * @param dependencies - `{locker, namespaceQueue, now, fileSystem?, homeDirectory?, logWarning?, maxFileBytes?}` (object)
 * @returns `{now, readNamespace, updateNamespace, removeNamespace, listNamespaceFiles}` (object)
 *
 * @example
 * const result = await client.updateNamespace("orders", (state, nowMs) => ({ ... }), { signal });
 */
export function createStateStoreClient(environment, dependencies) {
  const storeDirectory = resolveStoreDirectory(environment, dependencies.homeDirectory);
  const context = { ...dependencies, fileSystem: dependencies.fileSystem ?? nodeFileSystem, logWarning: dependencies.logWarning ?? logToStderr, storeDirectory };
  return {
    now: () => dependencies.now(),
    readNamespace: (namespace) => readNamespaceState(context, namespace),
    updateNamespace: (namespace, mutate, options) => runLocked(context, namespace, options?.signal, updateLocked(context, namespace, mutate)),
    removeNamespace: (namespace, options) => runLocked(context, namespace, options?.signal, removeLocked(context, namespace)),
    listNamespaceFiles: () => listNamespaceFiles(context),
  };
}

function describePaths(context, namespace) {
  const dataPath = join(context.storeDirectory, `${namespace}${STATE_FILE_SUFFIX}`);
  return { dataPath, lockPath: join(context.storeDirectory, `${namespace}.lock`) };
}

async function readNamespaceState(context, namespace) {
  const { dataPath } = describePaths(context, namespace);
  let fileText;
  try {
    fileText = await context.fileSystem.readFile(dataPath, "utf8");
  } catch (readError) {
    if (readError.code === "ENOENT") return createEmptyState(namespace);
    throw storageError(`Could not read ${dataPath}`, readError);
  }
  return parseState(fileText, namespace, dataPath);
}

async function runLocked(context, namespace, signal, task) {
  return context.namespaceQueue(namespace, async () => {
    if (signal?.aborted) throw new PluginError(`Cancelled before updating namespace ${namespace}`, { kind: "cancelled" });
    await ensureStoreDirectory(context);
    const { lockPath } = describePaths(context, namespace);
    const lockHandle = await context.locker.acquire(lockPath, signal);
    try {
      return await task(lockHandle);
    } finally {
      await releaseLockSafely(context, lockPath, lockHandle);
    }
  });
}

// A release failure is only logged: after a committed write, reporting failure would make a caller retry an
// update that already happened, and after a failed task it would hide the real error. A lock left behind
// names this process with a token it no longer holds, so the next acquire treats it as stale.
async function releaseLockSafely(context, lockPath, lockHandle) {
  try {
    await lockHandle.release();
  } catch (releaseError) {
    context.logWarning(`could not release the lock ${lockPath}: ${releaseError.code ?? releaseError.message}`);
  }
}

// Once the lock is held the update always runs to the end: a half-applied update is never written. An update
// that changed nothing (not even a purge) writes nothing.
function updateLocked(context, namespace, mutate) {
  return async (lockHandle) => {
    await removeLeftoverTemporaryFiles(context, namespace);
    const nowMs = context.now();
    const state = purgeExpiredUnlessClockJumped(context, await readNamespaceState(context, namespace), nowMs);
    const result = mutate(state, nowMs);
    if (hasStateChanges(state)) await writeStateFile(context, state, serializeState(state, nowMs), lockHandle);
    return result;
  };
}

// A clock that jumps forward (bad NTP sync, wrong RTC) would expire most ids at once, and a purge cannot be
// undone: when the store was last written over CLOCK_JUMP_SUSPECT_AFTER_MS ago and the purge would drop more
// than CLOCK_JUMP_SUSPECT_PURGE_SHARE of the seen ids, it is skipped (once: this write moves updated_at on).
// Expired ids still count as unseen; skipping only keeps them on disk in case the clock is wrong.
function purgeExpiredUnlessClockJumped(context, state, nowMs) {
  const isLongSinceLastWrite = state.updatedAt !== null && nowMs - state.updatedAt > CLOCK_JUMP_SUSPECT_AFTER_MS;
  if (!isLongSinceLastWrite) return purgeExpired(state, nowMs);
  const expiredCount = countExpiredSeenIds(state, nowMs);
  if (expiredCount <= state.seen.size * CLOCK_JUMP_SUSPECT_PURGE_SHARE) return purgeExpired(state, nowMs);
  context.logWarning(
    `namespace ${state.namespace}: skipped purging ${expiredCount} of ${state.seen.size} seen ids, because the last write was ${new Date(state.updatedAt).toISOString()} and the clock may have jumped forward; they are purged on the next write`,
  );
  return state;
}

function removeLocked(context, namespace) {
  return async (lockHandle) => {
    const { dataPath } = describePaths(context, namespace);
    await lockHandle.assertHeld();
    try {
      await context.fileSystem.rm(dataPath);
      return true;
    } catch (removeError) {
      if (removeError.code === "ENOENT") return false;
      throw storageError(`Could not delete ${dataPath}`, removeError);
    }
  };
}

async function writeStateFile(context, state, fileText, lockHandle) {
  requireFileSizeWithinLimit(context, state, Buffer.byteLength(fileText));
  const { dataPath } = describePaths(context, state.namespace);
  const temporaryPath = `${dataPath}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    await writeAndSync(context, temporaryPath, fileText);
    await lockHandle.assertHeld();
    await context.fileSystem.rename(temporaryPath, dataPath);
  } catch (writeError) {
    await context.fileSystem.rm(temporaryPath, { force: true });
    if (writeError instanceof PluginError) throw writeError;
    throw storageError(`Could not write ${dataPath}; nothing was changed`, writeError, true);
  }
  await syncDirectory(context);
}

function requireFileSizeWithinLimit(context, state, fileBytes) {
  const maxFileBytes = context.maxFileBytes ?? MAX_FILE_BYTES;
  if (fileBytes <= maxFileBytes) return;
  throw new PluginError(
    `Namespace ${state.namespace} would grow to ${fileBytes} bytes; the limit is ${maxFileBytes} bytes (it holds ${state.seen.size} seen ids and ${state.values.size} keys). Nothing was written. ` +
      "To make room, remove large keys with `delete`, remove ids with `forget_seen` or mark them with a shorter ttl_days, or spread the data over several namespaces",
    { kind: "invalid_input" },
  );
}

// Temp files are only written under the lock, so while we hold it any left over are from a crashed writer.
async function removeLeftoverTemporaryFiles(context, namespace) {
  const leftoverPattern = new RegExp(`^${namespace.replaceAll(".", "\\.")}\\.json\\.[0-9a-f]{32}\\.tmp$`);
  let fileNames;
  try {
    fileNames = await context.fileSystem.readdir(context.storeDirectory);
  } catch (readError) {
    context.logWarning(`could not list ${context.storeDirectory} to remove leftover temp files: ${readError.code ?? readError.message}`);
    return;
  }
  for (const fileName of fileNames.filter((candidate) => leftoverPattern.test(candidate))) {
    await context.fileSystem.rm(join(context.storeDirectory, fileName), { force: true });
  }
}

async function writeAndSync(context, filePath, fileText) {
  const fileHandle = await context.fileSystem.open(filePath, "wx", 0o600);
  try {
    await fileHandle.writeFile(fileText);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}

// The rename already happened, so the update is applied: a failed directory fsync is only logged, never
// reported as a failure (a caller retrying filter_unseen would then see its new ids as already seen).
async function syncDirectory(context) {
  let directoryHandle;
  try {
    directoryHandle = await context.fileSystem.open(context.storeDirectory, "r");
    await directoryHandle.sync();
  } catch (syncError) {
    if (!["EINVAL", "EISDIR", "EPERM", "ENOTSUP"].includes(syncError.code)) context.logWarning(`fsync of ${context.storeDirectory} failed: ${syncError.code ?? syncError.message}`);
  } finally {
    await directoryHandle?.close();
  }
}

async function ensureStoreDirectory(context) {
  try {
    await context.fileSystem.mkdir(context.storeDirectory, { recursive: true, mode: 0o700 });
  } catch (mkdirError) {
    throw storageError(`Could not create the state directory ${context.storeDirectory}`, mkdirError);
  }
}

async function listNamespaceFiles(context) {
  let entries;
  try {
    entries = await context.fileSystem.readdir(context.storeDirectory, { withFileTypes: true });
  } catch (readError) {
    if (readError.code === "ENOENT") return [];
    throw storageError(`Could not list ${context.storeDirectory}`, readError);
  }
  const namespaces = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(STATE_FILE_SUFFIX))
    .map((entry) => entry.name.slice(0, -STATE_FILE_SUFFIX.length))
    .filter((namespace) => NAMESPACE_PATTERN.test(namespace))
    .sort();
  return Promise.all(namespaces.map((namespace) => describeNamespaceFile(context, namespace)));
}

async function describeNamespaceFile(context, namespace) {
  const fileStats = await context.fileSystem.stat(describePaths(context, namespace).dataPath).catch(() => null);
  return { namespace, bytes: fileStats?.size ?? null, modifiedAtMs: fileStats?.mtimeMs ?? null };
}

function storageError(message, cause, retryable = false) {
  return new PluginError(`${message}: ${cause.code ?? cause.message}`, { kind: "storage_error", retryable });
}

function logToStderr(message) {
  console.error(`state-store: ${message}`);
}
