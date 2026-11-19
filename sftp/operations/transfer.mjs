/**
 * Transfers: download (server → a new generated file in SFTP_OUTPUT_DIR) and
 * upload (a file in SFTP_INPUT_DIRS → the server; tools need the opt-in,
 * overwrites are node only). Both stream with a size cap.
 */
import { constants as fileConstants, createWriteStream } from "node:fs";
import { basename, extname, posix } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildNameHint, OUTPUT_NAME_PARAMETER } from "../lib/file-access.mjs";
import { invalidInput, operationFailed, permissionDenied } from "../lib/errors.mjs";
import { callSftp, describeRemoteType, resolveExistingRemote, resolveNewRemote } from "../lib/remote-files.mjs";
import { REMOTE_PATH_PARAMETER } from "./browse.mjs";

const SAFE_OPEN_FLAGS = fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0) | (fileConstants.O_NONBLOCK ?? 0);

function createSizeLimit(maxBytes, label) {
  let totalBytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, done) {
      totalBytes += chunk.length;
      done(totalBytes > maxBytes ? invalidInput(`${label} is over the ${maxBytes}-byte limit`) : null, chunk);
    },
  });
  return { limiter, bytesSeen: () => totalBytes };
}

function chooseExtension(remoteName) {
  const extension = extname(remoteName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : "bin";
}

async function downloadToStaging(client, sftp, { serverPath, size, outputName }) {
  const naming = { nameHint: buildNameHint(outputName, basename(serverPath)), extension: chooseExtension(basename(serverPath)) };
  const staging = await client.fileAccess.createStagingOutput(naming);
  const { limiter, bytesSeen } = createSizeLimit(client.settings.files.maxOutputBytes, "The download");
  try {
    await pipeline(sftp.createReadStream(serverPath), limiter, createWriteStream(staging.stagingPath, { flags: "wx", mode: 0o644 }));
    if (bytesSeen() !== size) throw operationFailed(`The download stopped at ${bytesSeen()} of ${size} bytes`);
    return await staging.publish();
  } catch (downloadError) {
    await staging.discard();
    throw downloadError;
  }
}

const downloadOperation = {
  name: "download",
  title: "Download a file",
  description: "Downloads a file from the SFTP server (inside SFTP_ROOT) into a new file with a generated name in SFTP_OUTPUT_DIR; nothing local is overwritten",
  parameters: {
    type: "object",
    properties: { path: REMOTE_PATH_PARAMETER, output_name: OUTPUT_NAME_PARAMETER },
    required: ["path"],
  },
  run: async ({ client, args, signal }) => client.withSession(signal, async (sftp, connection) => {
    const source = await resolveExistingRemote(sftp, connection.remoteRoot, args.path);
    const attributes = await callSftp(sftp, "stat", source.serverPath);
    if (describeRemoteType(attributes) !== "file") throw invalidInput(`${JSON.stringify(args.path)} is not a regular file`);
    if (attributes.size > client.settings.files.maxOutputBytes) throw invalidInput(`${JSON.stringify(args.path)} is ${attributes.size} bytes, over the ${client.settings.files.maxOutputBytes}-byte limit (SFTP_MAX_OUTPUT_BYTES)`);
    const outputPath = await downloadToStaging(client, sftp, { serverPath: source.serverPath, size: attributes.size, outputName: args.output_name });
    return { data: { remote_path: source.virtualPath, path: outputPath, file_name: basename(outputPath), size_bytes: attributes.size } };
  }),
};

async function openLocalSource(client, localPath) {
  const resolved = await client.fileAccess.resolveInputFile(localPath, { parameterName: "local_path" });
  const fileHandle = await client.fileSystem.open(resolved.path, SAFE_OPEN_FLAGS);
  const fileStats = await fileHandle.stat();
  if (!fileStats.isFile() || fileStats.nlink > 1) {
    await fileHandle.close();
    throw invalidInput(`${JSON.stringify(localPath)} changed while it was being opened; nothing was uploaded`);
  }
  return { fileHandle, sizeBytes: fileStats.size };
}

async function checkExistingTarget(sftp, target, args, source) {
  const existing = await callSftp(sftp, "lstat", target.serverPath).catch(() => null);
  if (!existing) return null;
  if (!args.overwrite) throw invalidInput(`${JSON.stringify(args.path)} already exists on the server; nothing was uploaded (a workflow node may pass overwrite: true)`);
  if (source !== "node") throw permissionDenied("Only workflow nodes may overwrite a file on the server");
  if (describeRemoteType(existing) !== "file") throw invalidInput(`${JSON.stringify(args.path)} is not a regular file and cannot be overwritten`);
  return existing;
}

async function uploadStaged(client, sftp, { local, target, existing }) {
  const stagingPath = posix.join(target.parentPath, `.${target.name.slice(0, 64)}.${client.randomSuffix()}.partial`);
  try {
    await pipeline(local.fileHandle.createReadStream(), sftp.createWriteStream(stagingPath, { flags: "wx", mode: 0o644 }));
    // Some servers' rename replaces an existing file, so check again right before it (a small race remains).
    if (!existing && (await callSftp(sftp, "lstat", target.serverPath).catch(() => null))) {
      throw invalidInput(`${JSON.stringify(target.virtualPath)} was created on the server meanwhile; nothing was uploaded`);
    }
    await callSftp(sftp, existing ? "ext_openssh_rename" : "rename", stagingPath, target.serverPath);
  } catch (uploadError) {
    await callSftp(sftp, "unlink", stagingPath).catch(() => {});
    throw uploadError;
  }
}

const uploadOperation = {
  name: "upload",
  title: "Upload a file",
  description: "Uploads a local file from SFTP_INPUT_DIRS to the SFTP server inside SFTP_ROOT: staged under a temporary name, then renamed. Existing files are never replaced unless a workflow node passes overwrite. Agents need SFTP_TOOL_ALLOW_WRITES=1",
  parameters: {
    type: "object",
    properties: {
      local_path: { type: "string", description: "Local file inside SFTP_INPUT_DIRS (absolute, ~/..., or relative to the first one)" },
      path: REMOTE_PATH_PARAMETER,
      overwrite: { type: "boolean", default: false, description: "Replace an existing regular file (workflow nodes only; needs the server's posix-rename extension)" },
      create_parents: { type: "boolean", default: false, description: "Create missing remote directories inside SFTP_ROOT" },
    },
    required: ["local_path", "path"],
  },
  run: async ({ client, args, signal, source }) => {
    client.assertWriteAllowed(source, "upload");
    if (args.overwrite && source !== "node") throw permissionDenied("Only workflow nodes may overwrite a file on the server");
    const local = await openLocalSource(client, args.local_path);
    try {
      return await client.withSession(signal, async (sftp, connection) => {
        const target = await resolveNewRemote(sftp, connection.remoteRoot, args.path, { createParents: args.create_parents });
        const existing = await checkExistingTarget(sftp, target, args, source);
        await uploadStaged(client, sftp, { local, target, existing });
        return { data: { path: target.virtualPath, size_bytes: local.sizeBytes, created: !existing } };
      });
    } finally {
      await local.fileHandle.close().catch(() => {});
    }
  },
};

export const transferOperations = [downloadOperation, uploadOperation];
