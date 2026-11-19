/**
 * Read-only operations on single paths: list_allowed_directories, stat and read_file.
 */
import { readFileSlice } from "../lib/file-reader.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { describeFileType } from "../lib/path-guard.mjs";

/** Schema for a path parameter; relative paths start at the first allowed directory. */
export const PATH_PARAMETER = {
  type: "string",
  description: "Absolute path, ~/..., or a path relative to the first allowed directory; must stay inside LOCAL_FILES_ALLOWED_DIRS",
};
const DEFAULT_READ_BYTES = 262144;

/**
 * Describes a path for results.
 *
 * @param realPath - Real path (string)
 * @param stats - fs.Stats (object)
 * @returns `{path, type, size_bytes, modified_at}` (object)
 */
export function describePath(realPath, stats) {
  return { path: realPath, type: describeFileType(stats), size_bytes: stats.size, modified_at: stats.mtime.toISOString() };
}

const listAllowedDirectoriesOperation = {
  name: "list_allowed_directories",
  title: "List allowed directories",
  description: "Lists the directories (LOCAL_FILES_ALLOWED_DIRS) this plugin may read and write, as real paths, and whether each exists",
  parameters: { type: "object", properties: {} },
  run: async ({ client }) => {
    const roots = await client.pathGuard.listRoots();
    return { data: { directories: roots.map((root) => ({ path: root.realPath ?? root.configuredPath, exists: root.realPath !== null })) } };
  },
};

const statOperation = {
  name: "stat",
  title: "Stat a path",
  description: "Describes a file or directory inside the allowed directories (type, size, times, permission bits, hard links) without opening it; files with more than one hard link are refused",
  parameters: { type: "object", properties: { path: PATH_PARAMETER }, required: ["path"] },
  run: async ({ client, args }) => {
    const { realPath, stats } = await client.pathGuard.resolveExisting(args.path);
    // A hard link inside an allowed directory can share its inode (size, times) with a file outside it.
    if (stats.isFile() && stats.nlink > 1) throw invalidInput(`${JSON.stringify(args.path)} has ${stats.nlink} hard links and is refused (a hard link could point outside the allowed directories)`);
    return {
      data: {
        ...describePath(realPath, stats),
        created_at: stats.birthtime.toISOString(),
        accessed_at: stats.atime.toISOString(),
        mode: `0${(stats.mode & 0o777).toString(8).padStart(3, "0")}`,
        hard_links: stats.nlink,
      },
    };
  },
};

const readFileOperation = {
  name: "read_file",
  title: "Read a file",
  description: "Reads a regular file inside the allowed directories as UTF-8 text or base64, up to max_bytes from offset; `truncated` and `next_offset` say when more remains",
  parameters: {
    type: "object",
    properties: {
      path: PATH_PARAMETER,
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8", description: "utf8 for text (refused when the bytes are not valid UTF-8), base64 for binary files" },
      offset: { type: "integer", minimum: 0, default: 0, description: "Byte offset to start at (use next_offset from a truncated read)" },
      max_bytes: { type: "integer", minimum: 1, default: DEFAULT_READ_BYTES, description: "Most bytes to read (default 256 KiB; never more than LOCAL_FILES_MAX_READ_BYTES)" },
    },
    required: ["path"],
  },
  run: async ({ client, args }) => {
    const maxBytes = Math.min(args.max_bytes, client.settings.maxReadBytes);
    return { data: await readFileSlice(client, { rawPath: args.path, offset: args.offset, maxBytes, encoding: args.encoding }) };
  },
};

export const readOperations = [listAllowedDirectoriesOperation, statOperation, readFileOperation];
