/**
 * `upload_file`: Drive's multipart upload (https://developers.google.com/workspace/drive/api/guides/manage-uploads#multipart).
 * Written by hand because Drive needs `multipart/related` (a JSON metadata part, then the media part) on the
 * /upload host path, while the declarative layer only sends multipart/form-data.
 *
 * The file is an https URL (public-https checks) or an absolute path inside GOOGLE_DRIVE_UPLOAD_DIR (realpath
 * checks), at most 5 MB (Drive's limit for multipart uploads). Creating a file is an unsafe write: it is never
 * retried after an unknown outcome.
 */
import { randomBytes } from "node:crypto";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { readFileInput } from "./shared/rest-files.mjs";

export const UPLOAD_DIR_ENV = "GOOGLE_DRIVE_UPLOAD_DIR";
const UPLOAD_BASE_URL = "https://www.googleapis.com/upload/drive/v3";
const MAX_MULTIPART_BYTES = 5 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120000;
export const UPLOADED_FILE_FIELDS = "id,name,mimeType,size,parents,webViewLink";

export const uploadFileOperation = {
  name: "upload_file",
  title: "Upload file",
  description: `Upload a file up to 5 MB (https URL, or an absolute path inside $${UPLOAD_DIR_ENV}) into a folder, optionally converting it to a Google Docs/Sheets/Slides file`,
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: `An https URL, or an absolute path inside $${UPLOAD_DIR_ENV}` },
      name: { type: "string", description: "File name in Drive (default: the source file's name)" },
      folder_id: { type: "string", description: "Parent folder id (default: My Drive root)" },
      description: { type: "string" },
      convert_to: { type: "string", enum: ["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"], description: "Convert to this Google type (e.g. .docx to a Google Doc)" },
      content_type: { type: "string", description: "Media type of the content (default: from the file extension)" },
    },
    required: ["file"],
  },
  run: (context) => uploadFile(context),
};

async function uploadFile({ client, args, environment, signal }) {
  const fileInput = await readFileInput(args.file, { paramName: "file", fileDirEnv: UPLOAD_DIR_ENV, environment, maxBytes: MAX_MULTIPART_BYTES, fetchImpl: client.fetchImpl, resolveHostAddresses: client.resolveHostAddresses, signal });
  const { body, boundary } = buildMultipartRelatedBody(buildMetadata(args, fileInput.fileName), fileInput.bytes, args.content_type || fileInput.contentType);
  const uploadClient = client.clientFor(UPLOAD_BASE_URL);
  const created = await uploadClient.request({
    method: "POST",
    path: "/files",
    query: { uploadType: "multipart", supportsAllDrives: true, fields: UPLOADED_FILE_FIELDS },
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body,
    idempotent: false,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    signal,
    redactResponse: true,
  }).catch((uploadError) => {
    throw describeUploadFailure(uploadError);
  });
  return { data: created, next_cursor: null };
}

function buildMetadata(args, sourceFileName) {
  const metadata = { name: args.name || sourceFileName };
  if (args.folder_id) metadata.parents = [args.folder_id];
  if (args.description) metadata.description = args.description;
  if (args.convert_to) metadata.mimeType = args.convert_to;
  return metadata;
}

/**
 * Builds a multipart/related body: the JSON metadata part, then the media part.
 *
 * @param metadata - Drive file metadata (object)
 * @param contentBytes - File content (Buffer | Uint8Array)
 * @param contentType - Media type of the content (string)
 * @param boundary - Boundary (string, default random; never occurs in the JSON part, and 32 random hex characters
 *   are vanishingly unlikely in the content)
 * @returns `{body: Buffer, boundary}` (object)
 * @throws PluginError kind `invalid_input` - A content type with line breaks
 */
export function buildMultipartRelatedBody(metadata, contentBytes, contentType, boundary = `graphrt-${randomBytes(16).toString("hex")}`) {
  if (/[\r\n]/.test(contentType)) throw new PluginError("`content_type` must not contain line breaks", { kind: "invalid_input" });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
  return { body: Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(contentBytes), Buffer.from(`\r\n--${boundary}--`, "utf8")]), boundary };
}

function describeUploadFailure(uploadError) {
  if (!(uploadError instanceof PluginError) || !/outcome unknown/.test(uploadError.message)) return uploadError;
  return new PluginError(`${uploadError.message}. To check: search_files for the name in the folder`, { kind: uploadError.kind, retryable: false });
}
