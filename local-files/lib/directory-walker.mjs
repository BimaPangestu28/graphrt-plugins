/**
 * Bounded, depth-first directory walks (local-files' list_directory and
 * search_files, file-watcher's snapshots).
 *
 * Entries come from `readdir(..., {withFileTypes: true})`, which does not
 * follow symlinks, so a symlink is reported as a symlink and never descended
 * into. Names are sorted so results are stable. Directories that cannot be
 * read are collected in `problems` (and reported), not silently skipped.
 *
 * This file is identical in the local-files and file-watcher plugins; keep the
 * copies in step.
 */
import { join } from "node:path";
import { throwIfCancelled } from "./errors.mjs";

const MAX_REPORTED_PROBLEMS = 20;

/**
 * Walks `startPath` depth-first.
 *
 * @param fileSystem - `node:fs` promises API (object)
 * @param startPath - Real directory inside the allowlist (string)
 * @param options - `{maxDepth, includeHidden, signal, problems}`; problems collects `{path, error}` (object)
 * @returns Async iterator of `{path, name, dirent, depth}` (AsyncGenerator)
 * @throws PluginError kind `cancelled` - When the signal fires
 */
export async function* walkDirectoryTree(fileSystem, startPath, options) {
  yield* walkDirectory(fileSystem, startPath, 1, options);
}

async function* walkDirectory(fileSystem, directoryPath, depth, options) {
  throwIfCancelled(options.signal, "The directory walk");
  const entries = await readEntries(fileSystem, directoryPath, options.problems);
  for (const dirent of entries) {
    if (!options.includeHidden && dirent.name.startsWith(".")) continue;
    const entryPath = join(directoryPath, dirent.name);
    yield { path: entryPath, name: dirent.name, dirent, depth };
    if (dirent.isDirectory() && depth < options.maxDepth) yield* walkDirectory(fileSystem, entryPath, depth + 1, options);
  }
}

async function readEntries(fileSystem, directoryPath, problems) {
  try {
    const entries = await fileSystem.readdir(directoryPath, { withFileTypes: true });
    return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (readError) {
    if (problems.length < MAX_REPORTED_PROBLEMS) problems.push({ path: directoryPath, error: readError?.code ?? readError?.message ?? String(readError) });
    return [];
  }
}

/**
 * Builds a matcher for a simple file-name glob: `*` any run of characters, `?` one character, everything else
 * literal. It uses the classic two-pointer wildcard match (backtracking only to the last `*`), so time is at most
 * pattern length × name length, never exponential like a `.*` regular expression on hostile patterns.
 *
 * @param pattern - Glob, e.g. "*.md" (string)
 * @param caseSensitive - Match case exactly (boolean)
 * @returns `(name) => boolean` (function)
 *
 * @example
 * createGlobMatcher("*.md", false)("README.MD"); // true
 */
export function createGlobMatcher(pattern, caseSensitive) {
  const normalize = (text) => [...(caseSensitive ? text : text.toLowerCase())];
  const patternCharacters = normalize(pattern).filter((character, index, all) => !(character === "*" && all[index - 1] === "*"));
  return (name) => matchWildcard(patternCharacters, normalize(name));
}

function matchWildcard(pattern, text) {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let textMark = 0;
  while (textIndex < text.length) {
    if (patternIndex < pattern.length && (pattern[patternIndex] === "?" || (pattern[patternIndex] !== "*" && pattern[patternIndex] === text[textIndex]))) {
      patternIndex += 1;
      textIndex += 1;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      textMark = textIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      textMark += 1;
      textIndex = textMark;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}
