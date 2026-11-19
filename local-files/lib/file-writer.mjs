/**
 * Staged writes: the content goes to a private `.<name>.<random>.partial`
 * file (created with `wx`, 0600) in the target's directory, is flushed, and is
 * then published in one step:
 * - a new file is hard-linked to its final name (`link()` never replaces an
 *   existing file) and the staging name removed;
 * - an overwrite (nodes only, and only when asked) checks that the existing
 *   target is a plain regular file with one link (no symlink, FIFO, device,
 *   directory or hard link), keeps its permission bits and atomically
 *   `rename()`s the staging file over it.
 * Readers never see a half-written file, and a failure removes the staging file.
 */
import { invalidInput, operationFailed } from "./errors.mjs";
import { join } from "node:path";

const STAGING_FILE_MODE = 0o600;
const NEW_FILE_MODE = 0o644;
const MAX_STAGING_NAME_LENGTH = 64;

/**
 * Writes `bytes` to `target`.
 *
 * @param client - `{fileSystem, randomSuffix, redactPaths}` (object)
 * @param request - `{target: {parentPath, name, finalPath}, bytes, overwrite, rawPath}` (object)
 * @returns `{path, size_bytes, created}` (Promise<object>)
 * @throws PluginError kinds `invalid_input` (exists without overwrite, unsafe target), `plugin_error` (I/O failure)
 */
export async function writeFileStaged(client, { target, bytes, overwrite, rawPath }) {
  const existingStats = await client.fileSystem.lstat(target.finalPath).catch((lstatError) => {
    if (lstatError?.code === "ENOENT") return null;
    throw lstatError;
  });
  if (existingStats && !overwrite) throw invalidInput(`${JSON.stringify(rawPath)} already exists; nothing was written (a workflow node may pass overwrite: true)`);
  if (existingStats) assertReplaceable(existingStats, rawPath);
  const stagingPath = join(target.parentPath, `.${target.name.slice(0, MAX_STAGING_NAME_LENGTH)}.${client.randomSuffix()}.partial`);
  try {
    await writeStagingFile(client.fileSystem, stagingPath, bytes);
    await publishStagingFile(client.fileSystem, { stagingPath, target, existingStats, rawPath });
  } catch (writeError) {
    await removeStagingFile(client.fileSystem, stagingPath);
    throw toPluginError(writeError, client.redactPaths, rawPath);
  }
  return { path: target.finalPath, size_bytes: bytes.length, created: !existingStats };
}

function assertReplaceable(existingStats, rawPath) {
  if (existingStats.isSymbolicLink()) throw invalidInput(`${JSON.stringify(rawPath)} is a symlink; write to the file it points to instead`);
  if (!existingStats.isFile()) throw invalidInput(`${JSON.stringify(rawPath)} is not a regular file and cannot be overwritten`);
  if (existingStats.nlink > 1) throw invalidInput(`${JSON.stringify(rawPath)} has ${existingStats.nlink} hard links and cannot be overwritten (one of them could be outside the allowed directories)`);
}

async function writeStagingFile(fileSystem, stagingPath, bytes) {
  const fileHandle = await fileSystem.open(stagingPath, "wx", STAGING_FILE_MODE);
  try {
    await fileHandle.writeFile(bytes);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}

async function publishStagingFile(fileSystem, { stagingPath, target, existingStats, rawPath }) {
  if (existingStats) {
    await fileSystem.chmod(stagingPath, existingStats.mode & 0o7777);
    await fileSystem.rename(stagingPath, target.finalPath);
    return;
  }
  await fileSystem.chmod(stagingPath, NEW_FILE_MODE);
  try {
    await fileSystem.link(stagingPath, target.finalPath);
  } catch (linkError) {
    if (linkError?.code === "EEXIST") throw invalidInput(`${JSON.stringify(rawPath)} was created by something else meanwhile; nothing was written`);
    throw linkError;
  }
  await removeStagingFile(fileSystem, stagingPath);
}

async function removeStagingFile(fileSystem, stagingPath) {
  await fileSystem.rm(stagingPath, { force: true }).catch((removeError) => {
    process.stderr.write(`local-files: could not remove staging file ${stagingPath}: ${removeError.message}\n`);
  });
}

function toPluginError(writeError, redactPaths, rawPath) {
  if (writeError?.kind) return writeError;
  return operationFailed(`Could not write ${JSON.stringify(rawPath)}: ${redactPaths(writeError?.message ?? String(writeError))}`);
}
