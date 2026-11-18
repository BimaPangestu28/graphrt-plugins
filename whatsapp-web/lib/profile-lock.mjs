/**
 * A pid lock file in the profile directory, so two plugin processes never
 * open the same WhatsApp profile at once. Headless Chromium does not enforce
 * this itself (checked live: a second headless launch on a busy profile
 * succeeds), and two writers would corrupt the session store.
 */
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const PROFILE_LOCK_FILE_NAME = "graphrt-whatsapp-web.lock";

/**
 * Takes the profile lock for this process; a lock left by a dead process is replaced.
 *
 * @param profileDirectory - Chromium profile directory (string)
 * @param options.isProcessAlive - `(pid) => boolean`, injectable for tests (function, optional)
 * @returns `release()` that removes the lock (Promise<() => Promise<void>>)
 * @throws PluginError kind `browser_error` - When another live process holds the profile
 */
export async function acquireProfileLock(profileDirectory, { isProcessAlive = checkProcessAlive } = {}) {
  const lockPath = join(profileDirectory, PROFILE_LOCK_FILE_NAME);
  if (await tryCreateLock(lockPath)) return () => releaseLock(lockPath);
  const holderPid = Number.parseInt(await readFile(lockPath, "utf8").catch(() => ""), 10);
  if (Number.isInteger(holderPid) && holderPid !== process.pid && isProcessAlive(holderPid)) {
    throw new PluginError(
      `The WhatsApp Web profile ${profileDirectory} is in use by another process (pid ${holderPid}); wait for it to finish or stop it. If no other graphrt run uses it, delete ${lockPath}`,
      { kind: "browser_error" },
    );
  }
  await rm(lockPath, { force: true });
  if (!(await tryCreateLock(lockPath))) throw new PluginError(`Could not lock the WhatsApp Web profile ${profileDirectory}`, { kind: "browser_error" });
  return () => releaseLock(lockPath);
}

async function tryCreateLock(lockPath) {
  try {
    const lockFile = await open(lockPath, "wx");
    await lockFile.writeFile(String(process.pid));
    await lockFile.close();
    return true;
  } catch (openError) {
    if (openError.code === "EEXIST") return false;
    throw openError;
  }
}

async function releaseLock(lockPath) {
  const holderPid = await readFile(lockPath, "utf8").catch(() => null);
  if (holderPid === String(process.pid)) await rm(lockPath, { force: true });
}

function checkProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (signalError) {
    return signalError.code === "EPERM";
  }
}
