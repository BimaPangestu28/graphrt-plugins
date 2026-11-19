/**
 * Directory changes on the server: make_directory (tools need the opt-in) and
 * delete_path (node only; one file, symlink or empty directory, never recursive).
 */
import { posix } from "node:path";
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { callSftp, describeRemoteType, resolveExistingRemote, resolveNewRemote, toVirtualPath } from "../lib/remote-files.mjs";
import { REMOTE_PATH_PARAMETER } from "./browse.mjs";

const makeDirectoryOperation = {
  name: "make_directory",
  title: "Make a remote directory",
  description: "Creates a directory on the SFTP server inside SFTP_ROOT (with create_parents, missing parents too). Agents need SFTP_TOOL_ALLOW_WRITES=1",
  parameters: {
    type: "object",
    properties: { path: REMOTE_PATH_PARAMETER, create_parents: { type: "boolean", default: false, description: "Create missing parents inside SFTP_ROOT" } },
    required: ["path"],
  },
  run: async ({ client, args, signal, source }) => {
    client.assertWriteAllowed(source, "make_directory");
    return client.withSession(signal, async (sftp, connection) => {
      const target = await resolveNewRemote(sftp, connection.remoteRoot, args.path, { createParents: args.create_parents });
      const existing = await callSftp(sftp, "lstat", target.serverPath).catch(() => null);
      if (existing) return { data: { path: target.virtualPath, created: false, type: describeRemoteType(existing) } };
      await callSftp(sftp, "mkdir", target.serverPath, {});
      return { data: { path: target.virtualPath, created: true } };
    });
  },
};

const deletePathOperation = {
  name: "delete_path",
  title: "Delete a remote file or empty directory",
  description: "Deletes one file, symlink (the link itself) or empty directory on the SFTP server inside SFTP_ROOT; never recursive, never SFTP_ROOT itself (workflow nodes only)",
  nodeOnly: true,
  parameters: { type: "object", properties: { path: REMOTE_PATH_PARAMETER }, required: ["path"] },
  run: async ({ client, args, signal }) => client.withSession(signal, async (sftp, connection) => {
    const virtualPath = toVirtualPath(args.path);
    if (virtualPath === "/") throw new PluginError("SFTP_ROOT itself cannot be deleted", { kind: "invalid_input" });
    const parent = await resolveExistingRemote(sftp, connection.remoteRoot, posix.dirname(virtualPath));
    const serverPath = posix.join(parent.serverPath, posix.basename(virtualPath));
    const attributes = await callSftp(sftp, "lstat", serverPath).catch(() => {
      throw new PluginError(`No file or directory at ${JSON.stringify(args.path)} inside SFTP_ROOT`, { kind: "not_found" });
    });
    const type = describeRemoteType(attributes);
    await callSftp(sftp, type === "directory" ? "rmdir" : "unlink", serverPath);
    return { data: { path: posix.join(parent.virtualPath, posix.basename(virtualPath)), deleted: type } };
  }),
};

export const manageOperations = [makeDirectoryOperation, deletePathOperation];
