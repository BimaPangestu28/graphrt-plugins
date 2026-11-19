/**
 * `upload_file`: Slack's three-step external upload flow, which the declarative layer cannot express because the
 * bytes go to a URL returned by the first call (https://docs.slack.dev/messaging/working-with-files#upload).
 *
 *   1. POST files.getUploadURLExternal {filename, length}   -> {upload_url, file_id}
 *   2. POST the bytes to upload_url (files.slack.com, no token)
 *   3. POST files.completeUploadExternal {files: [{id, title}], channel_id?, initial_comment?, thread_ts?}
 *
 * Steps 1 and 2 change nothing visible and may be retried; step 3 shares the file, so it is an unsafe write
 * (never retried after an unknown outcome). Agent tools need SLACK_TOOL_ALLOW_SEND=1, like every other post.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { readFileInput } from "./shared/rest-files.mjs";
import { classifyTransferError } from "./shared/public-https-fetch.mjs";

export const UPLOAD_DIR_ENV = "SLACK_UPLOAD_DIR";
export const SEND_OPT_IN_ENV = "SLACK_TOOL_ALLOW_SEND";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120000;

/**
 * Refuses a tool call unless the send opt-in env is "1".
 *
 * @param context - Operation context `{source, environment}` (object)
 * @param operationName - Operation name for the message (string)
 * @returns Nothing
 * @throws PluginError kind `permission_denied` - Tool call without the opt-in
 */
export function assertSendAllowed({ source, environment }, operationName) {
  if (source !== "tool" || environment?.[SEND_OPT_IN_ENV] === "1") return;
  throw new PluginError(`\`${operationName}\` is disabled for agent tools; set ${SEND_OPT_IN_ENV}=1 to allow it, or use a workflow node`, { kind: "permission_denied" });
}

export const uploadFileOperation = {
  name: "upload_file",
  title: "Upload file",
  description: `Upload a file (https URL, or an absolute path inside $${UPLOAD_DIR_ENV}) and optionally share it in a channel or thread (as an agent tool only when ${SEND_OPT_IN_ENV}=1)`,
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: `An https URL, or an absolute path inside $${UPLOAD_DIR_ENV}` },
      filename: { type: "string", description: "File name shown in Slack (default: the source file's name)" },
      file_title: { type: "string", description: "File title shown in Slack (sent as `title`; default: the file name)" },
      channel_id: { type: "string", description: "Channel to share the file in; without it the file stays private to the uploader" },
      initial_comment: { type: "string", description: "Message posted with the file" },
      thread_ts: { type: "string", description: "Parent message ts, to upload as a thread reply (needs channel_id)" },
    },
    required: ["file"],
  },
  run: (context) => uploadFile(context),
};

async function uploadFile(context) {
  assertSendAllowed(context, "upload_file");
  const { client, args, environment, signal } = context;
  if (args.thread_ts && !args.channel_id) throw new PluginError("`thread_ts` needs `channel_id`", { kind: "invalid_input" });
  const fileInput = await readFileInput(args.file, { paramName: "file", fileDirEnv: UPLOAD_DIR_ENV, environment, maxBytes: MAX_UPLOAD_BYTES, fetchImpl: client.fetchImpl, resolveHostAddresses: client.resolveHostAddresses, signal });
  const filename = args.filename || fileInput.fileName;
  const uploadTarget = await client.request({ method: "POST", path: "/files.getUploadURLExternal", form: { filename, length: fileInput.bytes.length }, idempotent: true, signal, redactResponse: true });
  await sendFileBytes(client.fetchImpl, checkUploadUrl(uploadTarget.upload_url), fileInput, signal);
  const completion = await client.request({ method: "POST", path: "/files.completeUploadExternal", json: buildCompletion(args, uploadTarget.file_id, filename), idempotent: false, signal, redactResponse: true }).catch((completeError) => {
    throw describeCompletionFailure(completeError, uploadTarget.file_id);
  });
  return { data: { file_id: uploadTarget.file_id, files: completion.files ?? [] }, next_cursor: null };
}

/**
 * Accepts only an https upload URL on a slack.com host.
 *
 * @param uploadUrl - `upload_url` from files.getUploadURLExternal (string)
 * @returns The URL (string)
 * @throws PluginError kind `api_error` - Missing, not https, or not a Slack host
 */
export function checkUploadUrl(uploadUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(uploadUrl));
  } catch {
    throw new PluginError("Slack returned no usable upload_url", { kind: "api_error" });
  }
  const isSlackHost = parsedUrl.hostname === "slack.com" || parsedUrl.hostname.endsWith(".slack.com");
  if (parsedUrl.protocol !== "https:" || !isSlackHost) throw new PluginError(`Refusing to upload to ${parsedUrl.origin}: not a slack.com https URL`, { kind: "api_error" });
  return parsedUrl.href;
}

async function sendFileBytes(fetchImpl, uploadUrl, fileInput, signal) {
  const timeoutSignal = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  let uploadResponse;
  try {
    uploadResponse = await fetchImpl(uploadUrl, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: fileInput.bytes, signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
  } catch (transferError) {
    throw classifyTransferError(transferError, signal);
  }
  await uploadResponse.text().catch(() => "");
  if (uploadResponse.status !== 200) throw new PluginError(`Slack file upload failed with HTTP ${uploadResponse.status} (nothing was shared)`, { kind: uploadResponse.status === 429 ? "rate_limited" : "api_error", retryable: uploadResponse.status >= 500 });
}

function buildCompletion(args, fileId, filename) {
  const completion = { files: [{ id: fileId, title: args.file_title || filename }] };
  for (const fieldName of ["channel_id", "initial_comment", "thread_ts"]) if (args[fieldName]) completion[fieldName] = args[fieldName];
  return completion;
}

function describeCompletionFailure(completeError, fileId) {
  if (!(completeError instanceof PluginError) || !/outcome unknown/.test(completeError.message)) return completeError;
  return new PluginError(`${completeError.message}. To check: files.info for file ${fileId}`, { kind: completeError.kind, retryable: false });
}
