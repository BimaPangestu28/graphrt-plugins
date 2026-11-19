/**
 * Changing operations: write_file (tools need LOCAL_FILES_TOOL_ALLOW_WRITES=1,
 * overwrites are node only) and delete_path (node only).
 */
import { invalidInput, permissionDenied } from "../lib/errors.mjs";
import { writeFileStaged } from "../lib/file-writer.mjs";
import { describeFileType } from "../lib/path-guard.mjs";
import { TOOL_WRITES_VARIABLE } from "../lib/settings.mjs";
import { PATH_PARAMETER } from "./read.mjs";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function assertWriteAllowed(client, source, args) {
  if (source !== "node" && !client.settings.toolWritesAllowed) {
    throw permissionDenied(`write_file changes files, so agents may not call it. Use a workflow node, or set ${TOOL_WRITES_VARIABLE}=1 to let agents create new files.`);
  }
  if (source !== "node" && args.overwrite) {
    throw permissionDenied("Only workflow nodes may overwrite an existing file; agents can create new files only");
  }
}

/**
 * Decodes write_file content and checks the size cap.
 *
 * @param args - `{content, encoding}` (object)
 * @param maxWriteBytes - LOCAL_FILES_MAX_WRITE_BYTES (number)
 * @returns The bytes to write (Buffer)
 * @throws PluginError kind `invalid_input` - Malformed base64 or over the cap
 */
export function decodeContent({ content, encoding }, maxWriteBytes) {
  const compactBase64 = encoding === "base64" ? content.replace(/\s+/g, "") : null;
  if (compactBase64 !== null && (compactBase64.length % 4 !== 0 || !BASE64_PATTERN.test(compactBase64))) {
    throw invalidInput("`content` is not valid base64");
  }
  const bytes = compactBase64 !== null ? Buffer.from(compactBase64, "base64") : Buffer.from(content, "utf8");
  if (bytes.length > maxWriteBytes) throw invalidInput(`The content is ${bytes.length} bytes, over the ${maxWriteBytes}-byte limit (LOCAL_FILES_MAX_WRITE_BYTES); nothing was written`);
  return bytes;
}

const writeFileOperation = {
  name: "write_file",
  title: "Write a file",
  description: "Writes UTF-8 text or base64 bytes to a new file inside the allowed directories (staged, then published atomically). Existing files are never replaced unless a workflow node passes overwrite. Agents need LOCAL_FILES_TOOL_ALLOW_WRITES=1",
  parameters: {
    type: "object",
    properties: {
      path: PATH_PARAMETER,
      content: { type: "string", description: "Text, or base64 when encoding is base64 (must not be empty)" },
      encoding: { type: "string", enum: ["utf8", "base64"], default: "utf8", description: "How `content` is encoded" },
      overwrite: { type: "boolean", default: false, description: "Replace an existing regular file (workflow nodes only)" },
      create_parents: { type: "boolean", default: false, description: "Create missing parent directories inside the allowed directories" },
    },
    required: ["path", "content"],
  },
  run: async ({ client, args, source }) => {
    assertWriteAllowed(client, source, args);
    const bytes = decodeContent(args, client.settings.maxWriteBytes);
    const target = await client.pathGuard.resolveNewTarget(args.path, { createParents: args.create_parents });
    return { data: await writeFileStaged(client, { target, bytes, overwrite: args.overwrite, rawPath: args.path }) };
  },
};

async function removePath(client, { finalPath, stats }, rawPath) {
  if (!stats.isDirectory()) return client.fileSystem.unlink(finalPath);
  return client.fileSystem.rmdir(finalPath).catch((removeError) => {
    if (removeError?.code === "ENOTEMPTY" || removeError?.code === "EEXIST") throw invalidInput(`${JSON.stringify(rawPath)} is a directory that is not empty; only empty directories are deleted`);
    throw removeError;
  });
}

const deletePathOperation = {
  name: "delete_path",
  title: "Delete a file or empty directory",
  description: "Deletes one file, symlink (the link itself) or empty directory inside the allowed directories; never recursive, never an allowed directory itself (workflow nodes only)",
  nodeOnly: true,
  parameters: { type: "object", properties: { path: PATH_PARAMETER }, required: ["path"] },
  run: async ({ client, args }) => {
    const target = await client.pathGuard.resolveDeleteTarget(args.path);
    await removePath(client, target, args.path);
    return { data: { path: target.finalPath, deleted: describeFileType(target.stats) } };
  },
};

export const writeOperations = [writeFileOperation, deletePathOperation];
