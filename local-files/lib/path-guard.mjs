/**
 * Keeps every path the plugin touches inside LOCAL_FILES_ALLOWED_DIRS.
 *
 * The same rules as lib/file-access.mjs (shared with the local media
 * plugins), extended to directories and to targets that do not exist yet:
 * - both sides are realpath'd, and a path is inside a root only when it equals
 *   the root or starts with the root plus a separator (`/data/in-evil` is not
 *   inside `/data/in`);
 * - a new file's parent directory is realpath'd and checked, so `../` and a
 *   symlinked parent cannot lead out; the final name is never followed;
 * - anything outside the allowlist gets the same `not_found` as a missing
 *   path, so the plugin is no existence oracle for the rest of the disk.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHome } from "./environment-readers.mjs";
import { invalidInput, notFound, setupRequired } from "./errors.mjs";
import { ALLOWED_DIRS_VARIABLE } from "./settings.mjs";

const DIRECTORY_MODE = 0o755;

/**
 * Creates the path checks for one call.
 *
 * @param settings - From readLocalFilesSettings (object)
 * @param fileSystem - `node:fs` promises API or a test double (object)
 * @returns `{listRoots, resolveExisting, resolveNewTarget, resolveDeleteTarget, relativeToRoot}` (object)
 */
export function createPathGuard(settings, fileSystem) {
  const context = { settings, fileSystem };
  return {
    listRoots: () => listRoots(context),
    resolveExisting: (rawPath) => resolveExisting(context, rawPath),
    resolveNewTarget: (rawPath, options) => resolveNewTarget(context, rawPath, options),
    resolveDeleteTarget: (rawPath) => resolveDeleteTarget(context, rawPath),
    relativeToRoot: (realPath, roots) => relative(findRoot(realPath, roots) ?? dirname(realPath), realPath) || ".",
  };
}

/**
 * Whether `candidatePath` is one of `roots` or inside one (separator-suffixed prefix).
 *
 * @param candidatePath - Absolute, real path (string)
 * @param roots - Absolute, real directories (string[])
 * @returns True when inside or equal (boolean)
 */
export function isInsideOrEqual(candidatePath, roots) {
  return roots.some((root) => candidatePath === root || candidatePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

function findRoot(realPath, roots) {
  return roots.filter((root) => isInsideOrEqual(realPath, [root])).sort((left, right) => right.length - left.length)[0];
}

async function listRoots({ settings, fileSystem }) {
  if (settings.inputDirectories.length === 0) {
    throw setupRequired(`Set ${ALLOWED_DIRS_VARIABLE} to the directories (comma-separated, absolute or ~/...) this plugin may use`);
  }
  return Promise.all(settings.inputDirectories.map(async (configuredPath) => {
    const realPath = await fileSystem.realpath(configuredPath).catch(() => null);
    const isDirectory = realPath ? (await fileSystem.stat(realPath)).isDirectory() : false;
    return { configuredPath, realPath: isDirectory ? realPath : null };
  }));
}

async function requireRealRoots(context) {
  const realRoots = (await listRoots(context)).map((root) => root.realPath).filter(Boolean);
  if (realRoots.length === 0) throw setupRequired(`None of the ${ALLOWED_DIRS_VARIABLE} directories exist`);
  return realRoots;
}

function expandPath(rawPath, baseDirectory, homeDirectory) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") throw invalidInput("`path` must be a file or directory path");
  if (rawPath.includes("\0")) throw invalidInput("`path` must not contain NUL characters");
  const trimmedPath = rawPath.trim();
  if (trimmedPath === "~" || trimmedPath.startsWith("~/")) return expandHome(trimmedPath, homeDirectory, "`path`");
  return isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(baseDirectory, trimmedPath);
}

function outsideError(rawPath) {
  return notFound(`No file or directory at ${JSON.stringify(rawPath)} inside ${ALLOWED_DIRS_VARIABLE}`);
}

async function resolveExisting(context, rawPath) {
  const roots = await requireRealRoots(context);
  const givenPath = expandPath(rawPath, roots[0], context.settings.homeDirectory);
  const realPath = await context.fileSystem.realpath(givenPath).catch(() => null);
  if (!realPath || !isInsideOrEqual(realPath, roots)) throw outsideError(rawPath);
  return { realPath, stats: await context.fileSystem.stat(realPath), roots };
}

async function assertNotRoot(context, givenPath, roots, rawPath) {
  const realPath = await context.fileSystem.realpath(givenPath).catch(() => null);
  if (realPath && roots.includes(realPath)) throw invalidInput(`${JSON.stringify(rawPath)} is an allowed directory itself; name a file or directory inside it`);
}

async function resolveNewTarget(context, rawPath, { createParents = false } = {}) {
  const roots = await requireRealRoots(context);
  const givenPath = expandPath(rawPath, roots[0], context.settings.homeDirectory);
  await assertNotRoot(context, givenPath, roots, rawPath);
  const parentPath = await resolveParentDirectory(context, { parentGiven: dirname(givenPath), roots, rawPath, createParents });
  const name = basename(givenPath);
  return { parentPath, name, finalPath: join(parentPath, name), roots };
}

async function resolveParentDirectory(context, { parentGiven, roots, rawPath, createParents }) {
  const missingError = notFound(`No directory for ${JSON.stringify(rawPath)} inside ${ALLOWED_DIRS_VARIABLE} (create_parents: true creates missing directories inside it)`);
  const parentReal = await context.fileSystem.realpath(parentGiven).catch(() => null);
  if (parentReal) {
    if (!isInsideOrEqual(parentReal, roots)) throw missingError;
    if (!(await context.fileSystem.stat(parentReal)).isDirectory()) throw invalidInput(`The parent of ${JSON.stringify(rawPath)} is not a directory`);
    return parentReal;
  }
  if (!createParents) throw missingError;
  return createMissingDirectories(context, { parentGiven, roots, missingError });
}

// One mkdir at a time under an already checked real directory, re-checked after each step.
async function createMissingDirectories(context, { parentGiven, roots, missingError }) {
  const missingNames = [];
  let existingPath = parentGiven;
  let existingReal = await context.fileSystem.realpath(existingPath).catch(() => null);
  while (!existingReal) {
    if (dirname(existingPath) === existingPath) throw missingError;
    missingNames.unshift(basename(existingPath));
    existingPath = dirname(existingPath);
    existingReal = await context.fileSystem.realpath(existingPath).catch(() => null);
  }
  for (const directoryName of missingNames) {
    if (!isInsideOrEqual(existingReal, roots) || !(await context.fileSystem.stat(existingReal)).isDirectory()) throw missingError;
    const nextPath = join(existingReal, directoryName);
    await context.fileSystem.mkdir(nextPath, { mode: DIRECTORY_MODE }).catch((mkdirError) => {
      if (mkdirError?.code !== "EEXIST") throw mkdirError;
    });
    existingReal = await context.fileSystem.realpath(nextPath);
  }
  if (!isInsideOrEqual(existingReal, roots)) throw missingError;
  return existingReal;
}

async function resolveDeleteTarget(context, rawPath) {
  const roots = await requireRealRoots(context);
  const givenPath = expandPath(rawPath, roots[0], context.settings.homeDirectory);
  await assertNotRoot(context, givenPath, roots, rawPath);
  const parentReal = await context.fileSystem.realpath(dirname(givenPath)).catch(() => null);
  if (!parentReal || !isInsideOrEqual(parentReal, roots)) throw outsideError(rawPath);
  const finalPath = join(parentReal, basename(givenPath));
  const stats = await context.fileSystem.lstat(finalPath).catch(() => null);
  if (!stats) throw outsideError(rawPath);
  return { finalPath, stats };
}

/**
 * Names a file type for results.
 *
 * @param stats - fs.Stats from stat or lstat (object)
 * @returns "file", "directory", "symlink", "fifo", "socket", "character_device", "block_device" or "other" (string)
 */
export function describeFileType(stats) {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  return "other";
}
