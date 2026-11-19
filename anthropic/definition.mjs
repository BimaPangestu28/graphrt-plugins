/**
 * anthropic plugin definition: the Claude API (https://platform.claude.com/docs/en/api) for workflows that need a
 * second model: Messages (non-streaming), token counting, models, the Files API and Message Batches. Built with the
 * declarative REST layer (docs/declarative-plugins.md), plus one hand-written operation (lib/batch-results.mjs)
 * because batch results are large JSON Lines, streamed and filtered under a byte cap.
 *
 * Retries: `create_message` is paid, so it is "unsafe": a 5xx or timeout is when Claude may already have billed the
 * call, so it is never retried and its error says how to check (429 and 529 are still retried: nothing ran).
 * Free token counting stays "idempotent". `create_message_batch` can queue 100,000 paid requests, so agents need
 * ANTHROPIC_TOOL_ALLOW_BATCH=1.
 *
 * API version 2026-10-21: Messages requests may not send temperature, top_p or top_k, so they are not params.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createBatchResultsOperation } from "./lib/batch-results.mjs";

const API_VERSION = "2026-10-21";
const DEFAULT_MODEL = "claude-opus-5-5";
const GENERATION_TIMEOUT_MS = 280000;
const PAID_CHECK_HINT = "the call may have been billed; check usage in the Claude Console before retrying";
const idPagination = (maxLimit) => ({ dataPath: "data", cursorPath: "last_id", cursorParam: "after_id", hasMorePath: "has_more", limitParam: "limit", maxLimit });
const modelParam = { in: "body", type: "string", default: DEFAULT_MODEL, description: "Model id, e.g. claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5" };
const conversationParams = {
  messages: { in: "body", type: "array", items: { type: "object" }, required: true, description: 'Conversation, e.g. [{"role":"user","content":"Hi"}]' },
  system: { in: "body", type: "string", description: "System prompt" },
  tools: { in: "body", type: "array", items: { type: "object" }, description: "Tool definitions ({name, description, input_schema})" },
  tool_choice: { in: "body", type: "object", description: '{"type":"auto"} (forced tool choice is refused by the newest models)' },
  thinking: { in: "body", type: "object", description: '{"type":"adaptive"} (default on current models)' },
};
const batchIdParam = { batch_id: { in: "path", type: "string", required: true, description: "Message batch id (msgbatch_...)" } };
const fileIdParam = { file_id: { in: "path", type: "string", required: true, description: "File id (file_...)" } };

const createMessage = {
  name: "create_message",
  title: "Create message",
  description: "Ask Claude (not streamed); the reply text is in content[] blocks of type text. Check stop_reason (end_turn, max_tokens, refusal, tool_use)",
  method: "POST",
  path: "/v1/messages",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: modelParam,
    max_tokens: { in: "body", type: "integer", min: 1, max: 32000, default: 16000, description: "Cap on output tokens (non-streaming: keep it at most about 16000)" },
    ...conversationParams,
    output_config: { in: "body", type: "object", description: '{"effort":"low"|"medium"|"high"|"xhigh"|"max"} and/or {"format":{"type":"json_schema","schema":{...}}}' },
    stop_sequences: { in: "body", type: "array", items: { type: "string" }, description: "Custom stop sequences" },
    metadata: { in: "body", type: "object", description: '{"user_id": "..."} (an opaque id, no personal data)' },
  },
};

const countTokens = {
  name: "count_tokens",
  title: "Count tokens",
  description: "Count the input tokens a message request would use (free)",
  method: "POST",
  path: "/v1/messages/count_tokens",
  write: "idempotent",
  params: { model: modelParam, ...conversationParams },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List available Claude models, newest first, with max_input_tokens, max_tokens and capabilities",
  path: "/v1/models",
  response: idPagination(1000),
};

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "Get one model's context window, output cap and capabilities",
  path: "/v1/models/{model_id}",
  params: { model_id: { in: "path", type: "string", required: true, description: "Model id or alias" } },
};

const createMessageBatch = {
  name: "create_message_batch",
  title: "Create message batch",
  description: "Queue up to 100,000 Messages requests at 50% of the price; results within 24 h (poll get_message_batch)",
  method: "POST",
  path: "/v1/messages/batches",
  write: "unsafe",
  checkHint: "list_message_batches and look for a batch created just now",
  toolPolicy: "optIn:ANTHROPIC_TOOL_ALLOW_BATCH",
  params: {
    requests: {
      in: "body",
      type: "array",
      items: { type: "object" },
      required: true,
      maxItems: 100000,
      description: 'Requests, each {"custom_id":"a","params":{"model":"...","max_tokens":1024,"messages":[...]}}',
    },
  },
};

const getMessageBatch = {
  name: "get_message_batch",
  title: "Get message batch",
  description: "Get a batch's processing_status (in_progress, canceling, ended) and request_counts",
  path: "/v1/messages/batches/{batch_id}",
  params: batchIdParam,
};

const listMessageBatches = {
  name: "list_message_batches",
  title: "List message batches",
  description: "List message batches, newest first",
  path: "/v1/messages/batches",
  response: idPagination(1000),
};

const cancelMessageBatch = {
  name: "cancel_message_batch",
  title: "Cancel message batch",
  description: "Cancel a batch that is still processing (finished requests are still billed)",
  method: "POST",
  path: "/v1/messages/batches/{batch_id}/cancel",
  write: "idempotent",
  nodeOnly: true,
  params: batchIdParam,
};

const deleteMessageBatch = {
  name: "delete_message_batch",
  title: "Delete message batch",
  description: "Delete an ended batch and its results",
  method: "DELETE",
  path: "/v1/messages/batches/{batch_id}",
  write: "idempotent",
  nodeOnly: true,
  params: batchIdParam,
};

const uploadFile = {
  name: "upload_file",
  title: "Upload file",
  description: "Upload a file (PDF, text, image) to reference in messages as {\"type\":\"document\",\"source\":{\"type\":\"file\",\"file_id\":...}}",
  method: "POST",
  path: "/v1/files",
  write: "unsafe",
  checkHint: "list_files and look for the file name",
  bodyMode: "multipart",
  multipart: { fileDirEnv: "ANTHROPIC_UPLOAD_DIR", maxFileBytes: 100 * 1024 * 1024 },
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: { file: { in: "body", type: "string", file: true, required: true, description: "File to upload (max 100 MB here)" } },
};

const listFiles = {
  name: "list_files",
  title: "List files",
  description: "List uploaded files, newest first",
  path: "/v1/files",
  response: idPagination(1000),
};

const getFile = {
  name: "get_file",
  title: "Get file",
  description: "Get an uploaded file's metadata",
  path: "/v1/files/{file_id}",
  params: fileIdParam,
};

const deleteFile = {
  name: "delete_file",
  title: "Delete file",
  description: "Delete an uploaded file",
  method: "DELETE",
  path: "/v1/files/{file_id}",
  write: "idempotent",
  nodeOnly: true,
  params: fileIdParam,
};

const restDefinition = defineRestPlugin({
  name: "anthropic",
  version: "0.1.0",
  description: "Anthropic Claude API: messages (non-streaming), token counting, models, files and message batches",
  apiName: "Claude API",
  baseUrl: "https://api.anthropic.com",
  auth: { type: "header", header: "x-api-key", env: "ANTHROPIC_API_KEY" },
  defaultHeaders: { "anthropic-version": API_VERSION },
  limits: { timeout_ms: 600000 },
  // Errors are {"type": "error", "error": {"type": "authentication_error", "message": "..."}}; 529 is overloaded.
  errors: {
    messagePath: "error.message",
    codePath: "error.type",
    kindByCode: {
      authentication_error: "auth_error",
      permission_error: "permission_denied",
      billing_error: "permission_denied",
      not_found_error: "not_found",
      invalid_request_error: "invalid_input",
      request_too_large: "invalid_input",
      rate_limit_error: "rate_limited",
      overloaded_error: "rate_limited",
    },
    kindByStatus: { 529: "rate_limited" },
  },
  apiRequest: { examplePath: "/v1/models" },
  operations: [
    createMessage,
    countTokens,
    listModels,
    getModel,
    createMessageBatch,
    getMessageBatch,
    listMessageBatches,
    cancelMessageBatch,
    deleteMessageBatch,
    uploadFile,
    listFiles,
    getFile,
    deleteFile,
  ],
});

export const pluginDefinition = { ...restDefinition, operations: [...restDefinition.operations, createBatchResultsOperation()] };
