/**
 * Read-only remote operations: list_directory, stat and read_file.
 */
import { invalidInput } from "../lib/errors.mjs";
import { callSftp, describeRemoteEntry, describeRemoteType, resolveExistingRemote } from "../lib/remote-files.mjs";
import { posix } from "node:path";

/** Schema for a remote path; "/" is SFTP_ROOT. */
export const REMOTE_PATH_PARAMETER = { type: "string", description: "Path on the server relative to SFTP_ROOT (\"/\" is SFTP_ROOT itself; .. never leaves it)" };

const listDirectoryOperation = {
  name: "list_directory",
  title: "List a remote directory",
  description: "Lists a directory on the SFTP server inside SFTP_ROOT (name, type, size, modified time, permission bits), sorted by name",
  parameters: {
    type: "object",
    properties: {
      path: { ...REMOTE_PATH_PARAMETER, default: "/" },
      include_hidden: { type: "boolean", default: false, description: "Include names starting with a dot" },
      limit: { type: "integer", minimum: 1, maximum: 5000, default: 500, description: "Most entries; `truncated` says when there were more" },
    },
  },
  run: async ({ client, args, signal }) => client.withSession(signal, async (sftp, connection) => {
    const directory = await resolveExistingRemote(sftp, connection.remoteRoot, args.path);
    const listing = await callSftp(sftp, "readdir", directory.serverPath);
    const visible = listing.filter((entry) => entry.filename !== "." && entry.filename !== ".." && (args.include_hidden || !entry.filename.startsWith(".")))
      .sort((left, right) => (left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0));
    const entries = visible.slice(0, args.limit).map((entry) => ({ name: entry.filename, ...describeRemoteEntry(posix.join(directory.virtualPath, entry.filename), entry.attrs) }));
    return { data: { path: directory.virtualPath, entries, truncated: visible.length > args.limit } };
  }),
};

const statOperation = {
  name: "stat",
  title: "Stat a remote path",
  description: "Describes a file or directory on the SFTP server inside SFTP_ROOT (type, size, modified time, permission bits)",
  parameters: { type: "object", properties: { path: REMOTE_PATH_PARAMETER }, required: ["path"] },
  run: async ({ client, args, signal }) => client.withSession(signal, async (sftp, connection) => {
    const target = await resolveExistingRemote(sftp, connection.remoteRoot, args.path);
    return { data: describeRemoteEntry(target.virtualPath, await callSftp(sftp, "stat", target.serverPath)) };
  }),
};

async function readRange(stream, signal) {
  const chunks = [];
  for await (const chunk of stream) {
    if (signal?.aborted) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readFileOperation = {
  name: "read_file",
  title: "Read a remote file",
  description: "Reads a file on the SFTP server inside SFTP_ROOT as UTF-8 text or base64, up to max_bytes from offset; `truncated` says when more remains",
  parameters: {
    type: "object",
    properties: {
      path: REMOTE_PATH_PARAMETER,
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8", description: "utf8 for text (a cut may end in U+FFFD), base64 for binary" },
      offset: { type: "integer", minimum: 0, default: 0, description: "Byte offset to start at" },
      max_bytes: { type: "integer", minimum: 1, default: 262144, description: "Most bytes to read (never more than SFTP_MAX_READ_BYTES)" },
    },
    required: ["path"],
  },
  run: async ({ client, args, signal }) => client.withSession(signal, async (sftp, connection) => {
    const target = await resolveExistingRemote(sftp, connection.remoteRoot, args.path);
    const attributes = await callSftp(sftp, "stat", target.serverPath);
    if (describeRemoteType(attributes) !== "file") throw invalidInput(`${JSON.stringify(args.path)} is not a regular file`);
    const length = Math.max(0, Math.min(args.max_bytes, client.settings.maxReadBytes, attributes.size - args.offset));
    const bytes = length === 0 ? Buffer.alloc(0) : await readRange(sftp.createReadStream(target.serverPath, { start: args.offset, end: args.offset + length - 1 }), signal);
    const truncated = args.offset + bytes.length < attributes.size;
    return {
      data: { path: target.virtualPath, size_bytes: attributes.size, offset: args.offset, bytes_read: bytes.length, next_offset: truncated ? args.offset + bytes.length : null, truncated, encoding: args.encoding, content: bytes.toString(args.encoding) },
    };
  }),
};

export const browseOperations = [listDirectoryOperation, statOperation, readFileOperation];
