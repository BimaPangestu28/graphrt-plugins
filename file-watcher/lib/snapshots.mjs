/**
 * Snapshots of a directory inside FILE_WATCHER_ALLOWED_DIRS and the diff
 * between two of them.
 *
 * The directory is realpath'd and must be an allowed root or inside one
 * (separator-suffixed prefix); anything else is `not_found`. The walk never
 * follows symlinks and is bounded by depth and FILE_WATCHER_MAX_ENTRIES, which
 * counts every entry the walk visits (also those a name pattern skips).
 * An entry is "modified" when its type, size or mtime changed; a change that
 * keeps the size within the file system's mtime resolution can be missed.
 */
import { relative, sep } from "node:path";
import { createGlobMatcher, walkDirectoryTree } from "./directory-walker.mjs";
import { invalidInput, notFound, setupRequired } from "./errors.mjs";
import { ALLOWED_DIRS_VARIABLE } from "./settings.mjs";

function isInsideOrEqual(candidatePath, roots) {
  return roots.some((root) => candidatePath === root || candidatePath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

async function realRoots(client) {
  if (client.settings.allowedDirectories.length === 0) throw setupRequired(`Set ${ALLOWED_DIRS_VARIABLE} to the directories (comma-separated, absolute or ~/...) that may be watched`);
  const resolved = await Promise.all(client.settings.allowedDirectories.map((directory) => client.fileSystem.realpath(directory).catch(() => null)));
  return resolved.filter(Boolean);
}

/**
 * Resolves a directory to watch.
 *
 * @param client - `{settings, fileSystem}` (object)
 * @param givenPath - Absolute path, or relative to the first allowed directory (string)
 * @returns Real directory path (Promise<string>)
 * @throws PluginError kinds `setup_required`, `not_found` (missing or outside), `invalid_input` (not a directory)
 */
export async function resolveWatchDirectory(client, givenPath) {
  const roots = await realRoots(client);
  if (typeof givenPath !== "string" || givenPath.includes("\0")) throw invalidInput("`path` must be a directory path");
  const absolutePath = client.resolvePath(roots[0] ?? "/", givenPath);
  const realPath = await client.fileSystem.realpath(absolutePath).catch(() => null);
  if (!realPath || !isInsideOrEqual(realPath, roots)) throw notFound(`No directory at ${JSON.stringify(givenPath)} inside ${ALLOWED_DIRS_VARIABLE}`);
  if (!(await client.fileSystem.stat(realPath)).isDirectory()) throw invalidInput(`${JSON.stringify(givenPath)} is not a directory`);
  return realPath;
}

function describeType(dirent) {
  if (dirent.isFile()) return "file";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

/**
 * Takes a snapshot.
 *
 * @param client - `{settings, fileSystem, now}` (object)
 * @param request - `{root, options: {maxDepth, includeHidden, namePattern}, signal}` (object)
 * @returns `{root, options, takenAt, truncated, entries, unreadable}` (Promise<object>)
 */
export async function takeSnapshot(client, { root, options, signal }) {
  const matchesName = options.namePattern ? createGlobMatcher(options.namePattern, false) : () => true;
  const problems = [];
  const entries = [];
  let visitedCount = 0;
  let truncated = false;
  for await (const entry of walkDirectoryTree(client.fileSystem, root, { maxDepth: options.maxDepth, includeHidden: options.includeHidden, signal, problems })) {
    if (visitedCount === client.settings.maxEntries) {
      truncated = true;
      break;
    }
    visitedCount += 1;
    if (!matchesName(entry.name)) continue;
    const stats = await client.fileSystem.lstat(entry.path).catch(() => null);
    if (stats) entries.push([relative(root, entry.path), describeType(entry.dirent), stats.size, Math.trunc(stats.mtimeMs)]);
  }
  return { root, options, takenAt: client.now(), truncated, entries, unreadable: problems.map((problem) => relative(root, problem.path) || ".") };
}

function toChange([path, type, size, mtimeMs]) {
  return { path, type, size_bytes: size, modified_at: new Date(mtimeMs).toISOString() };
}

/**
 * Compares two snapshots of the same root.
 *
 * @param previous - Earlier snapshot (object)
 * @param current - Later snapshot (object)
 * @param maxChanges - Most changes to return in total (number)
 * @returns `{added, modified, removed, has_changes, changes_truncated}` (object)
 */
export function diffSnapshots(previous, current, maxChanges) {
  const before = new Map(previous.entries.map((entry) => [entry[0], entry]));
  const after = new Map(current.entries.map((entry) => [entry[0], entry]));
  const added = current.entries.filter((entry) => !before.has(entry[0]));
  const removed = previous.entries.filter((entry) => !after.has(entry[0]));
  const modified = current.entries.filter((entry) => {
    const earlier = before.get(entry[0]);
    return earlier && (earlier[1] !== entry[1] || earlier[2] !== entry[2] || earlier[3] !== entry[3]);
  });
  const total = added.length + removed.length + modified.length;
  let room = maxChanges;
  const take = (list) => {
    const taken = list.slice(0, Math.max(0, room));
    room -= taken.length;
    return taken.map(toChange);
  };
  return { added: take(added), modified: take(modified), removed: take(removed), has_changes: total > 0, changes_truncated: total > maxChanges };
}
