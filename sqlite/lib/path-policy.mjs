/**
 * Decides which database file a call may open.
 *
 * A database must be a regular file inside one of SQLITE_ALLOWED_DIRS. The
 * path is checked as given and again after realpath (both sides), with a
 * separator-suffixed prefix so `/data/db-evil` never matches `/data/db`.
 * FIFOs, devices, sockets and directories are refused before SQLite opens
 * them. A missing file and a file outside the allowlist get the same error.
 */
import { promises as defaultFileSystem } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { invalidInput, notFound, setupRequired } from "./errors.mjs";
import { ALLOWED_DIRS_VARIABLE, DEFAULT_PATH_VARIABLE, expandHome } from "./settings.mjs";

/**
 * Resolves and checks the database path for one call.
 *
 * @param rawPath - The `database` argument, or undefined to use SQLITE_PATH (string | undefined)
 * @param settings - From resolveSettings (object)
 * @param options - `{mode: "read" | "write", createIfMissing}` (object)
 * @param fileSystem - `{realpath, stat}` promise API, for tests (object, default node:fs/promises)
 * @returns The real path SQLite should open (string)
 * @throws PluginError kind `setup_required` - When SQLITE_ALLOWED_DIRS is unset
 * @throws PluginError kind `not_found` - When the file is missing or outside the allowed directories
 * @throws PluginError kind `invalid_input` - When the path is relative or not a regular file
 */
export async function resolveDatabasePath(rawPath, settings, { mode, createIfMissing = false }, fileSystem = defaultFileSystem) {
  if (settings.allowedDirectories.length === 0) {
    throw setupRequired(`Set ${ALLOWED_DIRS_VARIABLE} to the directories (comma-separated, absolute) that database files may be opened from`);
  }
  const givenPath = rawPath ? expandHome(rawPath, settings.homeDirectory, "`database`") : settings.defaultDatabasePath;
  if (!givenPath) throw invalidInput(`Pass \`database\` (an absolute path) or set ${DEFAULT_PATH_VARIABLE}`);
  const allowedRealDirectories = await realpathAll(settings.allowedDirectories, fileSystem);
  const outsideError = notFound(`No database file at ${JSON.stringify(givenPath)} inside ${ALLOWED_DIRS_VARIABLE}`);
  if (!isInsideAny(givenPath, [...settings.allowedDirectories, ...allowedRealDirectories])) throw outsideError;

  const realPath = await fileSystem.realpath(givenPath).catch((realpathError) => {
    if (realpathError?.code === "ENOENT") return null;
    throw outsideError;
  });
  if (realPath === null) return resolveNewDatabasePath(givenPath, allowedRealDirectories, { mode, createIfMissing, outsideError }, fileSystem);
  if (!isInsideAny(realPath, allowedRealDirectories)) throw outsideError;
  const fileStats = await fileSystem.stat(realPath);
  if (!fileStats.isFile()) throw invalidInput(`${JSON.stringify(givenPath)} is not a regular file`);
  return realPath;
}

// Only `execute` with create_if_missing may name a file that does not exist yet; its directory must be allowed.
async function resolveNewDatabasePath(givenPath, allowedRealDirectories, { mode, createIfMissing, outsideError }, fileSystem) {
  if (mode !== "write" || !createIfMissing) throw outsideError;
  const parentRealPath = await fileSystem.realpath(dirname(givenPath)).catch(() => {
    throw outsideError;
  });
  if (!allowedRealDirectories.some((allowedDirectory) => parentRealPath === allowedDirectory || parentRealPath.startsWith(withTrailingSeparator(allowedDirectory)))) {
    throw outsideError;
  }
  return join(parentRealPath, basename(givenPath));
}

async function realpathAll(directories, fileSystem) {
  const realDirectories = await Promise.all(directories.map((directory) => fileSystem.realpath(directory).catch(() => null)));
  return realDirectories.filter(Boolean);
}

function isInsideAny(candidatePath, directories) {
  return directories.some((directory) => candidatePath.startsWith(withTrailingSeparator(directory)));
}

function withTrailingSeparator(directory) {
  return directory.endsWith(sep) ? directory : `${directory}${sep}`;
}
