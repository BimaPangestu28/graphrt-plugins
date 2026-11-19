/**
 * Remote paths confined to SFTP_ROOT, and promise wrappers over ssh2's SFTP calls.
 *
 * Callers see virtual paths: "/" is SFTP_ROOT, and `..` can never climb
 * above it (paths are normalised against "/" first). The server's real path
 * is then checked with SFTP `realpath`, so a symlink on the server that leads
 * out of the root is refused too; a path outside gets the same `not_found`
 * as a missing one. A new file's parent is checked the same way and its
 * final name is never followed. The server could still swap a component for
 * a symlink between the check and the use; SFTP has no O_NOFOLLOW, so the
 * root is a guard rail, not a sandbox (use a chrooted SFTP account for that).
 */
import { posix } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Calls an ssh2 SFTP method and resolves with its result.
 *
 * @param sftp - ssh2 SFTPWrapper (object)
 * @param methodName - e.g. "stat" (string)
 * @param methodArguments - Arguments before the callback (any[])
 * @returns The callback's value (Promise)
 */
export function callSftp(sftp, methodName, ...methodArguments) {
  return new Promise((resolvePromise, rejectPromise) => {
    sftp[methodName](...methodArguments, (error, value) => (error ? rejectPromise(error) : resolvePromise(value)));
  });
}

/**
 * Whether `candidate` is `root` or inside it (separator-suffixed prefix).
 *
 * @param candidate - Absolute POSIX path (string)
 * @param root - Absolute POSIX root (string)
 * @returns True when inside or equal (boolean)
 */
export function isInsideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * Normalises a caller's path to a virtual path under "/".
 *
 * @param rawPath - Path from the call; relative paths start at "/" (string)
 * @returns Virtual path, e.g. "/reports/q1.csv" (string)
 * @throws PluginError kind `invalid_input` - NUL characters
 */
export function toVirtualPath(rawPath = "/") {
  const text = String(rawPath ?? "/").trim() || "/";
  if (text.includes("\0")) throw new PluginError("`path` must not contain NUL characters", { kind: "invalid_input" });
  return posix.resolve("/", text);
}

/**
 * Converts a server path inside the root back to a virtual path.
 *
 * @param serverPath - Absolute path on the server (string)
 * @param root - SFTP_ROOT (string)
 * @returns Virtual path (string)
 */
export function toVirtual(serverPath, root) {
  return `/${posix.relative(root, serverPath)}`;
}

function outside(rawPath) {
  return new PluginError(`No file or directory at ${JSON.stringify(rawPath)} inside SFTP_ROOT`, { kind: "not_found" });
}

/**
 * Resolves an existing remote path and checks it stays inside the root after symlinks.
 *
 * @param sftp - SFTP session (object)
 * @param root - SFTP_ROOT (string)
 * @param rawPath - Caller's path (string)
 * @returns `{serverPath, virtualPath}` (Promise<object>)
 * @throws PluginError kind `not_found` - Missing or outside the root
 */
export async function resolveExistingRemote(sftp, root, rawPath) {
  const realRoot = await callSftp(sftp, "realpath", root);
  const serverPath = await callSftp(sftp, "realpath", posix.join(realRoot, toVirtualPath(rawPath))).catch(() => null);
  if (!serverPath || !isInsideRoot(serverPath, realRoot)) throw outside(rawPath);
  await callSftp(sftp, "stat", serverPath).catch(() => {
    throw outside(rawPath);
  });
  return { serverPath, virtualPath: toVirtual(serverPath, realRoot), realRoot };
}

/**
 * Resolves the target of a new entry: its parent must exist (or be created) inside the root; the name is not followed.
 *
 * @param sftp - SFTP session (object)
 * @param root - SFTP_ROOT (string)
 * @param rawPath - Caller's path (string)
 * @param options - `{createParents}` (object)
 * @returns `{serverPath, virtualPath, parentPath, name}` (Promise<object>)
 * @throws PluginError kinds `not_found` (parent missing or outside), `invalid_input` (the root itself)
 */
export async function resolveNewRemote(sftp, root, rawPath, { createParents = false } = {}) {
  const virtualPath = toVirtualPath(rawPath);
  if (virtualPath === "/") throw new PluginError("SFTP_ROOT itself cannot be the target", { kind: "invalid_input" });
  const realRoot = await callSftp(sftp, "realpath", root);
  const parentVirtual = posix.dirname(virtualPath);
  let parent = await resolveExistingRemote(sftp, root, parentVirtual).catch(() => null);
  if (!parent && createParents) parent = await createRemoteDirectories(sftp, { root, realRoot, parentVirtual });
  if (!parent) throw new PluginError(`No directory for ${JSON.stringify(rawPath)} inside SFTP_ROOT (create_parents: true creates it)`, { kind: "not_found" });
  const name = posix.basename(virtualPath);
  const serverPath = posix.join(parent.serverPath, name);
  return { serverPath, virtualPath: toVirtual(serverPath, realRoot), parentPath: parent.serverPath, name };
}

// One mkdir at a time, each parent re-checked inside the root first.
async function createRemoteDirectories(sftp, { root, realRoot, parentVirtual }) {
  let current = { serverPath: realRoot, virtualPath: "/" };
  for (const segment of parentVirtual.split("/").filter(Boolean)) {
    const nextVirtual = posix.join(current.virtualPath, segment);
    const existing = await resolveExistingRemote(sftp, root, nextVirtual).catch(() => null);
    if (!existing) {
      await callSftp(sftp, "mkdir", posix.join(current.serverPath, segment), {});
    }
    current = await resolveExistingRemote(sftp, root, nextVirtual);
  }
  return current;
}

/**
 * Names an SFTP entry's type from its attributes.
 *
 * @param attributes - ssh2 Stats/attrs (object)
 * @returns "file", "directory", "symlink" or "other" (string)
 */
export function describeRemoteType(attributes) {
  const fileType = attributes.mode & 0o170000;
  if (fileType === 0o100000) return "file";
  if (fileType === 0o040000) return "directory";
  if (fileType === 0o120000) return "symlink";
  return "other";
}

/**
 * Describes a remote entry for results.
 *
 * @param virtualPath - Path under SFTP_ROOT (string)
 * @param attributes - ssh2 attrs (object)
 * @returns `{path, type, size_bytes, modified_at, mode}` (object)
 */
export function describeRemoteEntry(virtualPath, attributes) {
  return {
    path: virtualPath,
    type: describeRemoteType(attributes),
    size_bytes: attributes.size ?? null,
    modified_at: attributes.mtime ? new Date(attributes.mtime * 1000).toISOString() : null,
    mode: `0${(attributes.mode & 0o777).toString(8).padStart(3, "0")}`,
  };
}
