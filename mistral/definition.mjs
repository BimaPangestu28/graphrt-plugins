/**
 * mistral plugin definition: the Mistral AI API (https://docs.mistral.ai/api) for workflows that need a second model:
 * chat and fill-in-the-middle completions (non-streaming), embeddings, moderation, OCR, models, files and batch jobs.
 * Built with the declarative REST layer (docs/declarative-plugins.md); paths and fields follow the official
 * mistralai Python SDK.
 *
 * Retries: chat, FIM, embeddings, moderation and OCR are paid, so they are "unsafe": a 5xx or timeout is when Mistral
 * may already have billed the call, so it is never retried and its error says how to check (429 is still retried).
 * Uploads and batch creation are "unsafe" too; batch creation needs MISTRAL_TOOL_ALLOW_BATCH=1 for agents. Deletes and
 * cancels are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const GENERATION_TIMEOUT_MS = 280000;
const PAID_CHECK_HINT = "the call may have been billed; check usage in the Mistral console before retrying";
const FILE_PURPOSES = ["fine-tune", "batch", "ocr"];
const BATCH_ENDPOINTS = ["/v1/chat/completions", "/v1/embeddings", "/v1/fim/completions", "/v1/moderations", "/v1/chat/moderations", "/v1/ocr"];
const BATCH_STATUSES = ["QUEUED", "RUNNING", "SUCCESS", "FAILED", "TIMEOUT_EXCEEDED", "CANCELLATION_REQUESTED", "CANCELLED"];
const pageFromZero = (maxLimit) => ({ dataPath: "data", pagePagination: { pageParam: "page", sizeParam: "page_size", firstPage: 0 }, maxLimit });
const fileIdParam = { file_id: { in: "path", type: "string", required: true, description: "File id (a UUID)" } };
const jobIdParam = { job_id: { in: "path", type: "string", required: true, description: "Batch job id (a UUID)" } };

const createChatCompletion = {
  name: "create_chat_completion",
  title: "Create chat completion",
  description: "Generate a chat completion (not streamed); the answer is in choices[0].message.content",
  method: "POST",
  path: "/v1/chat/completions",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: { in: "body", type: "string", required: true, description: "Model id, e.g. mistral-small-latest, mistral-medium-latest or mistral-large-latest" },
    messages: { in: "body", type: "array", items: { type: "object" }, required: true, description: 'Messages, e.g. [{"role":"user","content":"Hi"}]' },
    max_tokens: { in: "body", type: "integer", min: 1, description: "Cap on generated tokens" },
    temperature: { in: "body", type: "number", min: 0, max: 1.5, description: "Sampling temperature" },
    response_format: { in: "body", type: "object", description: '{"type":"json_object"} or {"type":"json_schema","json_schema":{...}}' },
    tools: { in: "body", type: "array", items: { type: "object" }, description: "Function tool definitions" },
    safe_prompt: { in: "body", type: "boolean", description: "Prepend Mistral's safety system prompt" },
    random_seed: { in: "body", type: "integer", description: "Seed for deterministic sampling" },
    stop: { in: "body", type: "array", items: { type: "string" }, description: "Stop sequences" },
  },
  constants: { body: { stream: false } },
};

const createFimCompletion = {
  name: "create_fim_completion",
  title: "Fill in the middle (code)",
  description: "Complete code between a prompt and an optional suffix with Codestral; the code is in choices[0].message.content",
  method: "POST",
  path: "/v1/fim/completions",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: { in: "body", type: "string", default: "codestral-latest", description: "FIM model" },
    prompt: { in: "body", type: "string", required: true, description: "Code before the gap" },
    suffix: { in: "body", type: "string", description: "Code after the gap" },
    max_tokens: { in: "body", type: "integer", min: 1, description: "Cap on generated tokens" },
    stop: { in: "body", type: "array", items: { type: "string" }, description: "Stop sequences" },
  },
  constants: { body: { stream: false } },
};

const createEmbeddings = {
  name: "create_embeddings",
  title: "Create embeddings",
  description: "Embed texts as vectors; data[i].embedding belongs to input[i]",
  method: "POST",
  path: "/v1/embeddings",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  toolOutput: { maxChars: 20000 },
  params: {
    model: { in: "body", type: "string", default: "mistral-embed", description: "mistral-embed (text) or codestral-embed (code)" },
    input: { in: "body", type: "array", items: { type: "string" }, required: true, description: "Texts to embed" },
    output_dimension: { in: "body", type: "integer", min: 1, description: "Vector size (codestral-embed only)" },
    output_dtype: { in: "body", type: "string", enum: ["float", "int8", "uint8", "binary", "ubinary"], description: "Vector number type (codestral-embed only)" },
  },
};

const moderateText = {
  name: "moderate_text",
  title: "Moderate text",
  description: "Classify texts against Mistral's moderation categories; results[i].categories and category_scores",
  method: "POST",
  path: "/v1/moderations",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  params: {
    model: { in: "body", type: "string", default: "mistral-moderation-latest", description: "Moderation model" },
    input: { in: "body", type: "array", items: { type: "string" }, required: true, description: "Texts to classify" },
  },
};

const moderateChat = {
  name: "moderate_chat",
  title: "Moderate conversation",
  description: "Classify the last message of a conversation in its context",
  method: "POST",
  path: "/v1/chat/moderations",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  params: {
    model: { in: "body", type: "string", default: "mistral-moderation-latest", description: "Moderation model" },
    input: { in: "body", type: "array", items: { type: "object" }, required: true, description: 'Messages, e.g. [{"role":"user","content":"..."}]' },
  },
};

const ocrDocument = {
  name: "ocr_document",
  title: "OCR document",
  description: "Read a PDF or image into markdown per page (pages[].markdown), with optional structured annotation",
  method: "POST",
  path: "/v1/ocr",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: { in: "body", type: "string", default: "mistral-ocr-latest", description: "OCR model" },
    document: {
      in: "body",
      type: "object",
      required: true,
      description: '{"type":"document_url","document_url":"https://.../a.pdf"}, {"type":"image_url","image_url":"https://..."} or {"type":"file","file_id":"..."}',
    },
    pages: { in: "body", type: "array", items: { type: "integer" }, description: "Zero-based page numbers (default all)" },
    include_image_base64: { in: "body", type: "boolean", default: false, description: "Return the extracted images as base64 (large)" },
    image_limit: { in: "body", type: "integer", min: 0, description: "Maximum images to extract" },
    table_format: { in: "body", type: "string", enum: ["markdown", "html"], description: "Table output format" },
    extract_header: { in: "body", type: "boolean", description: "Move page headers into a header field" },
    extract_footer: { in: "body", type: "boolean", description: "Move page footers into a footer field" },
    document_annotation_format: { in: "body", type: "object", description: 'Structured output for the whole document, e.g. {"type":"json_schema","json_schema":{...}}' },
    document_annotation_prompt: { in: "body", type: "string", description: "Instructions for the document annotation" },
  },
};

const listModels = { name: "list_models", title: "List models", description: "List models available to the API key", path: "/v1/models", response: { dataPath: "data" } };

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "Get one model's capabilities, context length and aliases",
  path: "/v1/models/{model_id}",
  params: { model_id: { in: "path", type: "string", required: true, description: "Model id" } },
};

const listFiles = {
  name: "list_files",
  title: "List files",
  description: "List uploaded files",
  path: "/v1/files",
  params: {
    purpose: { in: "query", type: "string", enum: FILE_PURPOSES, description: "Only files with this purpose" },
    search: { in: "query", type: "string", description: "Search file names" },
  },
  response: pageFromZero(1000),
};

const uploadFile = {
  name: "upload_file",
  title: "Upload file",
  description: "Upload a file (batch .jsonl, a document for OCR, fine-tuning data) and get its id",
  method: "POST",
  path: "/v1/files",
  write: "unsafe",
  checkHint: "list_files with search set to the file name",
  bodyMode: "multipart",
  multipart: { fileDirEnv: "MISTRAL_UPLOAD_DIR", maxFileBytes: 100 * 1024 * 1024 },
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    file: { in: "body", type: "string", file: true, required: true, description: "File to upload (max 100 MB here)" },
    purpose: { in: "body", type: "string", enum: FILE_PURPOSES, required: true, description: "What the file is for" },
  },
};

const getFile = { name: "get_file", title: "Get file", description: "Get an uploaded file's metadata", path: "/v1/files/{file_id}", params: fileIdParam };

const downloadFileContent = {
  name: "download_file_content",
  title: "Download file content",
  description: "Save a file's content (e.g. a batch job's output_file) into $MISTRAL_OUTPUT_DIR",
  path: "/v1/files/{file_id}/content",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: fileIdParam,
  response: { binary: { envDir: "MISTRAL_OUTPUT_DIR", maxBytes: 200 * 1024 * 1024 } },
};

const deleteFile = { name: "delete_file", title: "Delete file", description: "Delete an uploaded file", method: "DELETE", path: "/v1/files/{file_id}", write: "idempotent", nodeOnly: true, params: fileIdParam };

const createBatchJob = {
  name: "create_batch_job",
  title: "Create batch job",
  description: "Start a batch job over uploaded .jsonl files or inline requests (half price); poll it with get_batch_job",
  method: "POST",
  path: "/v1/batch/jobs",
  write: "unsafe",
  checkHint: "list_batch_jobs and look for a job created just now",
  toolPolicy: "optIn:MISTRAL_TOOL_ALLOW_BATCH",
  params: {
    endpoint: { in: "body", type: "string", enum: BATCH_ENDPOINTS, required: true, description: "Endpoint every request calls" },
    model: { in: "body", type: "string", description: "Model for every request" },
    input_files: { in: "body", type: "array", items: { type: "string" }, description: 'File ids of .jsonl inputs, lines like {"custom_id":"0","body":{...}}' },
    requests: { in: "body", type: "array", items: { type: "object" }, description: 'Inline requests instead of files, each {"custom_id":"0","body":{...}}' },
    metadata: { in: "body", type: "object", description: "String key/value pairs" },
    timeout_hours: { in: "body", type: "integer", min: 1, description: "Give up after this many hours (default 24)" },
  },
};

const getBatchJob = { name: "get_batch_job", title: "Get batch job", description: "Get a batch job's status, counts and output_file", path: "/v1/batch/jobs/{job_id}", params: jobIdParam };

const listBatchJobs = {
  name: "list_batch_jobs",
  title: "List batch jobs",
  description: "List batch jobs, newest first",
  path: "/v1/batch/jobs",
  params: { status: { in: "query", type: "array", items: { type: "string", enum: BATCH_STATUSES }, style: "repeat", description: "Only jobs with these statuses" } },
  response: pageFromZero(1000),
};

const cancelBatchJob = {
  name: "cancel_batch_job",
  title: "Cancel batch job",
  description: "Request cancellation of a batch job (finished requests are still billed)",
  method: "POST",
  path: "/v1/batch/jobs/{job_id}/cancel",
  write: "idempotent",
  nodeOnly: true,
  params: jobIdParam,
};

export const pluginDefinition = defineRestPlugin({
  name: "mistral",
  version: "0.1.0",
  description: "Mistral AI API: chat and FIM completions (non-streaming), embeddings, moderation, OCR, models, files and batch jobs",
  apiName: "Mistral AI API",
  baseUrl: "https://api.mistral.ai",
  auth: { type: "bearer", env: "MISTRAL_API_KEY" },
  limits: { timeout_ms: 600000 },
  // 401 is {"message": "Unauthorized"}; 422 validation errors carry {"detail": [{"msg": ...}]}, sometimes under message.
  errors: { messagePath: ["message", "detail", "detail.0.msg", "message.detail.0.msg", "error.message"] },
  apiRequest: { examplePath: "/v1/models" },
  operations: [
    createChatCompletion,
    createFimCompletion,
    createEmbeddings,
    moderateText,
    moderateChat,
    ocrDocument,
    listModels,
    getModel,
    listFiles,
    uploadFile,
    getFile,
    downloadFileContent,
    deleteFile,
    createBatchJob,
    getBatchJob,
    listBatchJobs,
    cancelBatchJob,
  ],
});
