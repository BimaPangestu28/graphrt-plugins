/**
 * Directory operations: list_directory and search_files, both bounded walks
 * that never follow symlinks and never read hard-linked, oversized or binary files.
 */
import { createGlobMatcher, walkDirectoryTree } from "../lib/directory-walker.mjs";
import { invalidInput, throwIfCancelled } from "../lib/errors.mjs";
import { openRegularFile } from "../lib/file-reader.mjs";
import { describePath, PATH_PARAMETER } from "./read.mjs";

const MAX_LINE_LENGTH = 500;
const BINARY_SNIFF_BYTES = 8000;
const DIRECTORY_PATH_PARAMETER = { ...PATH_PARAMETER, default: ".", description: "Directory to start in (default: the first allowed directory); must stay inside LOCAL_FILES_ALLOWED_DIRS" };

async function resolveDirectory(client, rawPath) {
  const resolved = await client.pathGuard.resolveExisting(rawPath);
  if (!resolved.stats.isDirectory()) throw invalidInput(`${JSON.stringify(rawPath)} is not a directory`);
  return resolved;
}

function describeProblems(client, problems) {
  return problems.map((problem) => ({ path: problem.path, error: client.redactPaths(problem.error) }));
}

const listDirectoryOperation = {
  name: "list_directory",
  title: "List a directory",
  description: "Lists a directory inside the allowed directories (name, type, size, modified time), optionally recursing up to max_depth; symlinks are shown, never followed",
  parameters: {
    type: "object",
    properties: {
      path: DIRECTORY_PATH_PARAMETER,
      max_depth: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "1 lists only the directory itself; larger values recurse" },
      include_hidden: { type: "boolean", default: false, description: "Include names starting with a dot" },
      limit: { type: "integer", minimum: 1, maximum: 5000, default: 500, description: "Most entries to return; `truncated` says when there were more" },
    },
  },
  run: async ({ client, args, signal }) => {
    const { realPath, roots } = await resolveDirectory(client, args.path);
    const problems = [];
    const entries = [];
    let truncated = false;
    for await (const entry of walkDirectoryTree(client.fileSystem, realPath, { maxDepth: args.max_depth, includeHidden: args.include_hidden, signal, problems })) {
      if (entries.length === args.limit) {
        truncated = true;
        break;
      }
      const stats = await client.fileSystem.lstat(entry.path);
      entries.push({ ...describePath(entry.path, stats), name: entry.name, relative_path: client.pathGuard.relativeToRoot(entry.path, [realPath]) });
    }
    return { data: { path: realPath, relative_to_root: client.pathGuard.relativeToRoot(realPath, roots), entries, truncated, unreadable_directories: describeProblems(client, problems) } };
  },
};

function buildMatcher(args) {
  if (!args.name_pattern && !args.content) throw invalidInput("Pass `name_pattern`, `content` or both");
  const matchesName = args.name_pattern ? createGlobMatcher(args.name_pattern, args.case_sensitive) : () => true;
  const needle = args.content ? (args.case_sensitive ? args.content : args.content.toLowerCase()) : null;
  return {
    matchesName,
    needle,
    lineMatches: (line) => (args.case_sensitive ? line : line.toLowerCase()).includes(needle),
  };
}

// Reads one candidate file for a content search, or says why it was skipped.
async function readSearchableText(client, filePath) {
  let opened;
  try {
    opened = await openRegularFile(client.fileSystem, filePath, filePath);
  } catch (openError) {
    return { skipped: /hard link/.test(openError?.message ?? "") ? "hard_linked" : "unreadable" };
  }
  try {
    if (opened.fileStats.size > client.settings.maxReadBytes) return { skipped: "too_large" };
    const bytes = await opened.fileHandle.readFile();
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { skipped: "binary" };
    return { text: bytes.toString("utf8") };
  } finally {
    await opened.fileHandle.close();
  }
}

// At most `maxPerFile` matching lines; `hasMore` says the file had more.
function findLineMatches(text, matcher, describeFile, maxPerFile) {
  const matches = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!matcher.lineMatches(lines[index])) continue;
    if (matches.length === maxPerFile) return { matches, hasMore: true };
    matches.push({ ...describeFile, line_number: index + 1, line: lines[index].slice(0, MAX_LINE_LENGTH) });
  }
  return { matches, hasMore: false };
}

async function searchTree(client, { realPath, args, signal }) {
  const matcher = buildMatcher(args);
  const state = { matches: [], entriesScanned: 0, filesWithMoreMatches: 0, truncated: false, skipped: { binary: 0, too_large: 0, hard_linked: 0, unreadable: 0 }, problems: [] };
  // Every entry (directories and symlinks too) counts toward LOCAL_FILES_MAX_SEARCH_FILES, so empty trees are bounded.
  for await (const entry of walkDirectoryTree(client.fileSystem, realPath, { maxDepth: args.max_depth, includeHidden: args.include_hidden, signal, problems: state.problems })) {
    if (state.entriesScanned === client.settings.maxSearchFiles || state.matches.length >= args.max_results) {
      state.truncated = true;
      break;
    }
    state.entriesScanned += 1;
    throwIfCancelled(signal, "The search");
    if (!entry.dirent.isFile() || !matcher.matchesName(entry.name)) continue;
    const describeFile = { path: entry.path, relative_path: client.pathGuard.relativeToRoot(entry.path, [realPath]) };
    if (!matcher.needle) {
      state.matches.push(describeFile);
      continue;
    }
    const { text, skipped } = await readSearchableText(client, entry.path);
    if (skipped) {
      state.skipped[skipped] += 1;
      continue;
    }
    const found = findLineMatches(text, matcher, describeFile, args.max_matches_per_file);
    state.matches.push(...found.matches);
    if (found.hasMore) state.filesWithMoreMatches += 1;
  }
  if (state.matches.length > args.max_results) state.truncated = true;
  return state;
}

const searchFilesOperation = {
  name: "search_files",
  title: "Search files",
  description: "Finds files inside the allowed directories by name glob (* and ?) and/or by a plain-text substring in their content (no regular expressions); bounded by depth, entries scanned, matches per file and results",
  parameters: {
    type: "object",
    properties: {
      path: DIRECTORY_PATH_PARAMETER,
      name_pattern: { type: "string", description: "File name glob, e.g. *.md (* any characters, ? one character)" },
      content: { type: "string", description: "Plain text to find inside files, matched per line" },
      case_sensitive: { type: "boolean", default: false, description: "Match name_pattern and content case exactly" },
      include_hidden: { type: "boolean", default: false, description: "Search names starting with a dot too" },
      max_depth: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "How deep to recurse (1 = only the directory itself)" },
      max_results: { type: "integer", minimum: 1, maximum: 1000, default: 100, description: "Most matches to return; `truncated` says when the search stopped early" },
      max_matches_per_file: { type: "integer", minimum: 1, maximum: 1000, default: 10, description: "Most matching lines reported per file; `files_with_more_matches` counts files that had more" },
    },
  },
  run: async ({ client, args, signal }) => {
    const { realPath } = await resolveDirectory(client, args.path);
    const state = await searchTree(client, { realPath, args, signal });
    return {
      data: {
        path: realPath,
        matches: state.matches.slice(0, args.max_results),
        entries_scanned: state.entriesScanned,
        files_with_more_matches: state.filesWithMoreMatches,
        truncated: state.truncated,
        skipped_files: state.skipped,
        unreadable_directories: describeProblems(client, state.problems),
      },
    };
  },
};

export const browseOperations = [listDirectoryOperation, searchFilesOperation];
