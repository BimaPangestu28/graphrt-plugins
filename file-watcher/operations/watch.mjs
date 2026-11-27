/**
 * snapshot, list_changes and wait_for_change. graphrt calls are
 * request/response, so "watching" is polling: a snapshot becomes a cursor,
 * and a later call rescans and diffs against it.
 */
import { isAbsolute } from "node:path";
import { decodeCursor, encodeCursor } from "../lib/cursor.mjs";
import { invalidInput, throwIfCancelled } from "../lib/errors.mjs";
import { diffSnapshots, resolveWatchDirectory, takeSnapshot } from "../lib/snapshots.mjs";

export const MAX_WAIT_SECONDS = 300;
const MAX_NAME_PATTERN_LENGTH = 256;
const SCAN_PARAMETERS = {
  max_depth: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "How deep to look (1 = only the directory's own entries)" },
  include_hidden: { type: "boolean", default: false, description: "Include names starting with a dot" },
  name_pattern: { type: "string", description: `Only track entries whose name matches this glob (* and ?), e.g. *.csv; at most ${MAX_NAME_PATTERN_LENGTH} characters` },
};
const MAX_CHANGES_PARAMETER = { type: "integer", minimum: 1, maximum: 5000, default: 500, description: "Most changes to return; `changes_truncated` says when there were more" };
const PATH_PARAMETER = { type: "string", description: "Directory inside FILE_WATCHER_ALLOWED_DIRS (absolute, ~/..., or relative to the first one)" };

function scanOptions(args) {
  if ((args.name_pattern?.length ?? 0) > MAX_NAME_PATTERN_LENGTH) throw invalidInput(`\`name_pattern\` must be at most ${MAX_NAME_PATTERN_LENGTH} characters`);
  return { maxDepth: args.max_depth, includeHidden: args.include_hidden, namePattern: args.name_pattern ?? null };
}

// Cursor options must be ones the snapshot parameters themselves allow.
function assertCursorOptions(options) {
  const { maxDepth, includeHidden, namePattern } = options;
  const isValid = Number.isInteger(maxDepth) && maxDepth >= SCAN_PARAMETERS.max_depth.minimum && maxDepth <= SCAN_PARAMETERS.max_depth.maximum
    && typeof includeHidden === "boolean"
    && (namePattern === null || (typeof namePattern === "string" && namePattern.length <= MAX_NAME_PATTERN_LENGTH));
  if (!isValid) throw invalidInput("`cursor` has options outside the allowed limits; take a new snapshot");
}

/**
 * Decodes a caller's cursor and re-checks everything in it: the root must be the canonical real path of an allowed
 * directory (no relative paths, no symlinks), the options must be within the parameter limits, and the entry list
 * within FILE_WATCHER_MAX_ENTRIES. Walks then use the real path returned here, never the cursor's text.
 *
 * @param client - Client (object)
 * @param cursor - Cursor text (string)
 * @returns The snapshot with `root` set to the verified real path (Promise<object>)
 * @throws PluginError kinds `invalid_input` (damaged, non-canonical, over limits), `not_found` (outside the allowlist)
 */
async function snapshotFromCursor(client, cursor) {
  const previous = decodeCursor(cursor);
  // isAbsolute, not a leading "/": on Windows a directory is C:\\... and every cursor was refused here.
  if (!isAbsolute(previous.root)) throw invalidInput("`cursor` names a relative directory; take a new snapshot");
  assertCursorOptions(previous.options);
  if (previous.entries.length > client.settings.maxEntries) throw invalidInput("`cursor` has more entries than FILE_WATCHER_MAX_ENTRIES; take a new snapshot");
  const realRoot = await resolveWatchDirectory(client, previous.root);
  if (realRoot !== previous.root) throw invalidInput("`cursor` names a directory that is not canonical (a symlink or an unnormalised path); take a new snapshot");
  return { ...previous, root: realRoot, options: { maxDepth: previous.options.maxDepth, includeHidden: previous.options.includeHidden, namePattern: previous.options.namePattern } };
}

function describeSnapshot(snapshot) {
  return { path: snapshot.root, entry_count: snapshot.entries.length, truncated: snapshot.truncated, unreadable_directories: snapshot.unreadable ?? [], cursor: encodeCursor({ ...snapshot, unreadable: undefined }) };
}

function describeChanges(previous, current, maxChanges) {
  return { ...diffSnapshots(previous, current, maxChanges), ...describeSnapshot(current), since: new Date(previous.takenAt).toISOString() };
}

const snapshotOperation = {
  name: "snapshot",
  title: "Snapshot a directory",
  description: "Records the files and directories (type, size, modified time) under a directory inside the allowed directories and returns a cursor for list_changes or wait_for_change",
  parameters: { type: "object", properties: { path: { ...PATH_PARAMETER, default: "." }, ...SCAN_PARAMETERS } },
  run: async ({ client, args, signal }) => {
    const root = await resolveWatchDirectory(client, args.path);
    return { data: describeSnapshot(await takeSnapshot(client, { root, options: scanOptions(args), signal })) };
  },
};

const listChangesOperation = {
  name: "list_changes",
  title: "List changes since a cursor",
  description: "Rescans the directory of a cursor and lists what was added, modified or removed since it was taken, with a new cursor",
  parameters: { type: "object", properties: { cursor: { type: "string", description: "Cursor from snapshot, list_changes or wait_for_change" }, max_changes: MAX_CHANGES_PARAMETER }, required: ["cursor"] },
  run: async ({ client, args, signal }) => {
    const previous = await snapshotFromCursor(client, args.cursor);
    const current = await takeSnapshot(client, { root: previous.root, options: previous.options, signal });
    return { data: describeChanges(previous, current, args.max_changes) };
  },
};

async function pollUntilChanged(client, { baseline, timeoutMs, pollIntervalMs, signal, checkFirst }) {
  const startedAt = client.now();
  let current = baseline;
  let diff = null;
  if (checkFirst) {
    current = await takeSnapshot(client, { root: baseline.root, options: baseline.options, signal });
    diff = diffSnapshots(baseline, current, 1);
  }
  while (!diff?.has_changes) {
    const remainingMs = timeoutMs - (client.now() - startedAt);
    if (remainingMs <= 0) break;
    throwIfCancelled(signal, "Waiting for a change");
    await client.sleep(Math.min(pollIntervalMs, remainingMs), signal);
    current = await takeSnapshot(client, { root: baseline.root, options: baseline.options, signal });
    diff = diffSnapshots(baseline, current, 1);
  }
  return { current, waitedMs: client.now() - startedAt };
}

const waitForChangeOperation = {
  name: "wait_for_change",
  title: "Wait for a change",
  description: `Polls a directory (or a cursor's directory) until something is added, modified or removed, or until timeout_seconds (at most ${MAX_WAIT_SECONDS}) pass; returns the changes and a new cursor either way`,
  parameters: {
    type: "object",
    properties: {
      path: PATH_PARAMETER,
      cursor: { type: "string", description: "Wait for changes since this cursor (changes already made since it are returned at once); otherwise the wait starts now" },
      timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, default: 60, description: "Longest wait" },
      poll_interval_ms: { type: "integer", minimum: 250, maximum: 60000, default: 2000, description: "Time between rescans" },
      ...SCAN_PARAMETERS,
      max_changes: MAX_CHANGES_PARAMETER,
    },
  },
  run: async ({ client, args, signal }) => {
    if (!args.cursor && !args.path) throw invalidInput("Pass `path` (wait from now) or `cursor` (wait since that cursor)");
    const baseline = args.cursor
      ? await snapshotFromCursor(client, args.cursor)
      : await takeSnapshot(client, { root: await resolveWatchDirectory(client, args.path), options: scanOptions(args), signal });
    const { current, waitedMs } = await pollUntilChanged(client, { baseline, timeoutMs: args.timeout_seconds * 1000, pollIntervalMs: args.poll_interval_ms, signal, checkFirst: Boolean(args.cursor) });
    const changes = describeChanges(baseline, current, args.max_changes);
    return { data: { changed: changes.has_changes, waited_ms: waitedMs, ...changes } };
  },
};

export const watchOperations = [snapshotOperation, listChangesOperation, waitForChangeOperation];
