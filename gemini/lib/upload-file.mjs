/**
 * Files API upload for the gemini plugin.
 *
 * Gemini uploads use Google's resumable protocol (https://ai.google.dev/gemini-api/docs/files): a start request on
 * /upload/v1beta/files returns the session URL in the `x-goog-upload-url` response header, and a second request
 * sends the bytes with `x-goog-upload-command: upload, finalize`. The declarative layer has no two-step uploads or
 * response-header URLs, so this operation is hand-written on the plugin's own client (same API key, redaction and
 * error mapping). The session URL must stay on the upload host, so the key is never sent elsewhere.
 */
import { extname } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { readFileInput } from "./shared/rest-files.mjs";

export const UPLOAD_BASE_URL = "https://generativelanguage.googleapis.com/upload/v1beta";
const UPLOAD_HOST = "generativelanguage.googleapis.com";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 280000;
const CHECK_HINT = "list_files and look for the display name";
const TEXT_TYPES_BY_EXTENSION = {
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".js": "text/javascript",
  ".py": "text/x-python",
  ".rtf": "text/rtf",
};

/**
 * Builds the `upload_file` operation.
 *
 * @returns Operation `{name, title, description, parameters, run}` for operations.mjs (object)
 */
export function createUploadFileOperation() {
  return {
    name: "upload_file",
    title: "Upload file",
    description:
      'Upload a file (PDF, image, audio, video, text; max 100 MB here) for use in prompts as {"fileData":{"fileUri": file.uri, "mimeType": ...}}; files are kept 48 hours',
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "An https URL, or an absolute path inside GEMINI_UPLOAD_DIR" },
        display_name: { type: "string", description: "Name shown in list_files (default: the file name)" },
        mime_type: { type: "string", description: "Media type when the file's own is wrong or unknown, e.g. text/markdown" },
      },
      required: ["file"],
    },
    run: uploadFile,
  };
}

async function uploadFile({ client, args, environment, signal }) {
  const fileInput = await readFileInput(args.file, {
    paramName: "file",
    fileDirEnv: "GEMINI_UPLOAD_DIR",
    environment,
    maxBytes: MAX_UPLOAD_BYTES,
    fetchImpl: client.fetchImpl,
    resolveHostAddresses: client.resolveHostAddresses,
    signal,
  });
  const uploadClient = client.clientFor(UPLOAD_BASE_URL);
  const mimeType = args.mime_type ?? guessMediaType(fileInput);
  const sessionUrl = await startUploadSession(uploadClient, { byteCount: fileInput.bytes.length, mimeType, displayName: args.display_name ?? fileInput.fileName, signal });
  const finalized = await sendUploadBytes(uploadClient, sessionUrl, fileInput.bytes, signal);
  return { data: finalized.body?.file ?? finalized.body, next_cursor: null };
}

/**
 * Picks the media type: the file's own, or a text type from the extension when it is unknown.
 *
 * @param fileInput - `{fileName, contentType}` from readFileInput (object)
 * @returns Media type (string)
 */
export function guessMediaType(fileInput) {
  if (fileInput.contentType && fileInput.contentType !== "application/octet-stream") return fileInput.contentType;
  return TEXT_TYPES_BY_EXTENSION[extname(fileInput.fileName).toLowerCase()] ?? "application/octet-stream";
}

// Starting a session stores nothing, so it is safe to retry.
async function startUploadSession(uploadClient, { byteCount, mimeType, displayName, signal }) {
  const response = await uploadClient.requestWithHeaders({
    method: "POST",
    path: "/files",
    headers: {
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(byteCount),
      "x-goog-upload-header-content-type": mimeType,
    },
    json: { file: { display_name: displayName } },
    idempotent: true,
    redactResponse: true,
    signal,
  });
  return checkSessionUrl(response.headers?.get?.("x-goog-upload-url"));
}

/**
 * Checks the upload session URL from the start response: https on the Gemini upload host and path.
 *
 * @param sessionUrl - Value of the x-goog-upload-url header (string | null)
 * @returns The URL (string)
 * @throws PluginError kind `api_error` - Missing, or on another host or path
 */
export function checkSessionUrl(sessionUrl) {
  if (!sessionUrl) throw new PluginError("Gemini did not return an upload URL (x-goog-upload-url); nothing was uploaded", { kind: "api_error" });
  let parsedUrl;
  try {
    parsedUrl = new URL(sessionUrl);
  } catch {
    throw new PluginError("Gemini returned an invalid upload URL; nothing was uploaded", { kind: "api_error" });
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== UPLOAD_HOST || !parsedUrl.pathname.startsWith("/upload/")) {
    throw new PluginError(`Refusing the upload URL on ${parsedUrl.host}: only https://${UPLOAD_HOST}/upload/ is allowed; nothing was uploaded`, { kind: "api_error" });
  }
  return parsedUrl.href;
}

// Finalizing creates the file, so a failure has an unknown outcome and is never retried.
async function sendUploadBytes(uploadClient, sessionUrl, bytes, signal) {
  try {
    return await uploadClient.requestWithHeaders({
      method: "POST",
      path: sessionUrl,
      headers: { "x-goog-upload-command": "upload, finalize", "x-goog-upload-offset": "0", "content-type": "application/octet-stream" },
      body: bytes,
      idempotent: false,
      redactResponse: true,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      signal,
    });
  } catch (uploadError) {
    if (!(uploadError instanceof PluginError)) throw uploadError;
    throw new PluginError(`${uploadError.message}. To check: ${CHECK_HINT}`, { kind: uploadError.kind, retryable: false });
  }
}
