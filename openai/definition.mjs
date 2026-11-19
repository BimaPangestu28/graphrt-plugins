/**
 * openai plugin definition: the OpenAI API (https://platform.openai.com/docs/api-reference) for workflows that need
 * a second model: Responses and chat completions (non-streaming), embeddings, moderation, models, files and the
 * Batch API. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Write classes: every paid call (responses, chat completions, embeddings) is "unsafe": a timeout or 5xx is exactly
 * when OpenAI may already have billed it, so it is never retried and its error says how to check. Free moderation
 * stays "idempotent". Uploads and batch creation create objects and are "unsafe" too. Batch creation needs
 * OPENAI_TOOL_ALLOW_BATCH=1 for agents (one call can queue thousands of paid requests), and mcp/connector tools need
 * OPENAI_TOOL_ALLOW_REMOTE_TOOLS=1 (lib/remote-tools.mjs). Deletes and batch cancellation are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { guardRemoteTools, REMOTE_TOOLS_ENV } from "./lib/remote-tools.mjs";

const GENERATION_TIMEOUT_MS = 280000;
const BATCH_ENDPOINTS = ["/v1/responses", "/v1/chat/completions", "/v1/embeddings", "/v1/completions", "/v1/moderations"];
const FILE_PURPOSES = ["assistants", "batch", "fine-tune", "vision", "user_data", "evals"];
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const lastIdPagination = { dataPath: "data", lastItemCursor: { itemIdPath: "id", param: "after", hasMorePath: "has_more" }, limitParam: "limit" };
const PAID_CHECK_HINT = "the call may have been billed; check platform.openai.com/usage before retrying";
const modelParam = (description) => ({ in: "body", type: "string", required: true, description });

const createResponse = {
  name: "create_response",
  title: "Create response",
  description: "Generate a model response with the Responses API (text in, text or JSON out; not streamed). The answer text is in output[].content[].text",
  method: "POST",
  path: "/responses",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: modelParam("Model id, e.g. gpt-5-mini or gpt-5"),
    input: { in: "body", type: "string", required: true, minLength: 1, description: "Prompt text" },
    instructions: { in: "body", type: "string", description: "System/developer instructions" },
    max_output_tokens: { in: "body", type: "integer", min: 1, description: "Cap on output tokens, reasoning included" },
    reasoning_effort: { in: "body", type: "string", enum: REASONING_EFFORTS, wireName: "reasoning.effort", description: "Reasoning effort for reasoning models" },
    text_format: { in: "body", type: "object", wireName: "text.format", description: 'Output format, e.g. {"type":"json_schema","name":"x","schema":{...},"strict":true}' },
    tools: { in: "body", type: "array", items: { type: "object" }, description: "Tool definitions (function tools, web_search, ...)" },
    previous_response_id: { in: "body", type: "string", description: "Continue from a stored response (needs store: true on it)" },
    store: { in: "body", type: "boolean", default: false, description: "Store the response on OpenAI so it can be fetched or continued later" },
    temperature: { in: "body", type: "number", min: 0, max: 2, description: "Sampling temperature (not accepted by every model)" },
    metadata: { in: "body", type: "object", description: "Up to 16 string key/value pairs" },
  },
};

const getResponse = {
  name: "get_response",
  title: "Get response",
  description: "Get a stored response by id",
  path: "/responses/{response_id}",
  params: { response_id: { in: "path", type: "string", required: true, description: "Response id (resp_...)" } },
};

const deleteResponse = {
  name: "delete_response",
  title: "Delete response",
  description: "Delete a stored response",
  method: "DELETE",
  path: "/responses/{response_id}",
  write: "idempotent",
  nodeOnly: true,
  params: { response_id: { in: "path", type: "string", required: true, description: "Response id (resp_...)" } },
};

const createChatCompletion = {
  name: "create_chat_completion",
  title: "Create chat completion",
  description: "Generate a chat completion (not streamed). The answer is in choices[0].message.content",
  method: "POST",
  path: "/chat/completions",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: modelParam("Model id, e.g. gpt-5-mini"),
    messages: { in: "body", type: "array", items: { type: "object" }, required: true, description: 'Messages, e.g. [{"role":"user","content":"Hi"}]' },
    max_completion_tokens: { in: "body", type: "integer", min: 1, description: "Cap on generated tokens, reasoning included" },
    temperature: { in: "body", type: "number", min: 0, max: 2, description: "Sampling temperature (not accepted by every model)" },
    response_format: { in: "body", type: "object", description: '{"type":"json_object"} or {"type":"json_schema","json_schema":{...}}' },
    tools: { in: "body", type: "array", items: { type: "object" }, description: "Function tool definitions" },
    reasoning_effort: { in: "body", type: "string", enum: REASONING_EFFORTS, description: "Reasoning effort for reasoning models" },
    seed: { in: "body", type: "integer", description: "Best-effort deterministic sampling" },
    stop: { in: "body", type: "array", items: { type: "string" }, maxItems: 4, description: "Stop sequences" },
  },
  constants: { body: { stream: false } },
};

const createEmbeddings = {
  name: "create_embeddings",
  title: "Create embeddings",
  description: "Embed texts as vectors; data[i].embedding belongs to input[i]",
  method: "POST",
  path: "/embeddings",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  toolOutput: { maxChars: 20000 },
  params: {
    model: modelParam("Embedding model, e.g. text-embedding-3-small"),
    input: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 2048, description: "Texts to embed" },
    dimensions: { in: "body", type: "integer", min: 1, description: "Shorter vectors (text-embedding-3 models only)" },
  },
};

const createModeration = {
  name: "create_moderation",
  title: "Moderate text",
  description: "Classify text for harmful content (free): results[0].flagged and per-category scores",
  method: "POST",
  path: "/moderations",
  write: "idempotent",
  params: {
    input: { in: "body", type: "string", required: true, minLength: 1, description: "Text to classify" },
    model: { in: "body", type: "string", default: "omni-moderation-latest", description: "Moderation model" },
  },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List the models the API key can use",
  path: "/models",
  response: { dataPath: "data" },
};

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "Get one model's id, owner and creation time",
  path: "/models/{model}",
  params: { model: { in: "path", type: "string", required: true, description: "Model id" } },
};

const listFiles = {
  name: "list_files",
  title: "List files",
  description: "List uploaded files, newest first",
  path: "/files",
  params: {
    purpose: { in: "query", type: "string", enum: FILE_PURPOSES, description: "Only files with this purpose" },
    order: { in: "query", type: "string", enum: ["asc", "desc"], description: "Sort by creation time (default desc)" },
  },
  response: { ...lastIdPagination, maxLimit: 10000 },
};

const uploadFile = {
  name: "upload_file",
  title: "Upload file",
  description: "Upload a file (e.g. a .jsonl batch input) and get its file id",
  method: "POST",
  path: "/files",
  write: "unsafe",
  checkHint: "list_files and look for the file name",
  bodyMode: "multipart",
  multipart: { fileDirEnv: "OPENAI_UPLOAD_DIR", maxFileBytes: 100 * 1024 * 1024 },
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    file: { in: "body", type: "string", file: true, required: true, description: "File to upload (max 100 MB here)" },
    purpose: { in: "body", type: "string", enum: FILE_PURPOSES, required: true, description: "batch for Batch API input" },
  },
};

const getFile = {
  name: "get_file",
  title: "Get file",
  description: "Get an uploaded file's metadata",
  path: "/files/{file_id}",
  params: { file_id: { in: "path", type: "string", required: true, description: "File id (file-...)" } },
};

const downloadFileContent = {
  name: "download_file_content",
  title: "Download file content",
  description: "Save a file's content (e.g. a batch's output_file_id) into $OPENAI_OUTPUT_DIR",
  path: "/files/{file_id}/content",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: { file_id: { in: "path", type: "string", required: true, description: "File id (file-...)" } },
  response: { binary: { envDir: "OPENAI_OUTPUT_DIR", maxBytes: 200 * 1024 * 1024 } },
};

const deleteFile = {
  name: "delete_file",
  title: "Delete file",
  description: "Delete an uploaded file",
  method: "DELETE",
  path: "/files/{file_id}",
  write: "idempotent",
  nodeOnly: true,
  params: { file_id: { in: "path", type: "string", required: true, description: "File id (file-...)" } },
};

const createBatch = {
  name: "create_batch",
  title: "Create batch",
  description: "Start a Batch API job over an uploaded .jsonl file (50% cheaper, finishes within 24 h); poll it with get_batch",
  method: "POST",
  path: "/batches",
  write: "unsafe",
  checkHint: "list_batches and look for the input_file_id",
  toolPolicy: "optIn:OPENAI_TOOL_ALLOW_BATCH",
  params: {
    input_file_id: { in: "body", type: "string", required: true, description: "File id of the .jsonl input (purpose batch)" },
    endpoint: { in: "body", type: "string", enum: BATCH_ENDPOINTS, required: true, description: "Endpoint every line calls" },
    completion_window: { in: "body", type: "string", enum: ["24h"], default: "24h", description: "Only 24h is supported" },
    metadata: { in: "body", type: "object", description: "Up to 16 string key/value pairs" },
  },
};

const getBatch = {
  name: "get_batch",
  title: "Get batch",
  description: "Get a batch's status (validating, in_progress, completed, failed, expired, cancelled) and output_file_id",
  path: "/batches/{batch_id}",
  params: { batch_id: { in: "path", type: "string", required: true, description: "Batch id (batch_...)" } },
};

const listBatches = {
  name: "list_batches",
  title: "List batches",
  description: "List batches, newest first",
  path: "/batches",
  response: { ...lastIdPagination, maxLimit: 100 },
};

const cancelBatch = {
  name: "cancel_batch",
  title: "Cancel batch",
  description: "Cancel a running batch (finished requests are still billed)",
  method: "POST",
  path: "/batches/{batch_id}/cancel",
  write: "idempotent",
  nodeOnly: true,
  params: { batch_id: { in: "path", type: "string", required: true, description: "Batch id (batch_...)" } },
};

const restDefinition = defineRestPlugin({
  name: "openai",
  version: "0.1.0",
  description: "OpenAI API: Responses and chat completions (non-streaming), embeddings, moderation, models, files and batches",
  apiName: "OpenAI API",
  extraEnv: [REMOTE_TOOLS_ENV],
  baseUrl: "https://api.openai.com/v1",
  auth: { type: "bearer", env: "OPENAI_API_KEY" },
  limits: { timeout_ms: 600000 },
  // Errors are {"error": {"message", "type", "param", "code"}}.
  errors: {
    messagePath: "error.message",
    codePath: "error.code",
    // insufficient_quota is a 429 that waiting does not fix, so it must not be retried like a rate limit.
    kindByCode: { invalid_api_key: "auth_error", insufficient_quota: "permission_denied", model_not_found: "not_found", rate_limit_exceeded: "rate_limited" },
  },
  apiRequest: { examplePath: "/models" },
  operations: [
    createResponse,
    getResponse,
    deleteResponse,
    createChatCompletion,
    createEmbeddings,
    createModeration,
    listModels,
    getModel,
    listFiles,
    uploadFile,
    getFile,
    downloadFileContent,
    deleteFile,
    createBatch,
    getBatch,
    listBatches,
    cancelBatch,
  ],
});

export const pluginDefinition = {
  ...restDefinition,
  operations: restDefinition.operations.map((operation) => (operation.name === "create_response" ? guardRemoteTools(operation) : operation)),
};
