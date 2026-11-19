/**
 * gemini plugin definition: the Gemini API (https://ai.google.dev/api) for workflows that need a second model:
 * generateContent (non-streaming), countTokens, embeddings, models and the Files API. Built with the declarative
 * REST layer (docs/declarative-plugins.md), plus a hand-written `upload_file` (lib/upload-file.mjs) for Google's
 * two-step resumable upload.
 *
 * Model ids go in one path segment without the "models/" prefix (gemini-2.5-flash, not models/gemini-2.5-flash).
 * Retries: generation and embeddings are paid, so they are "unsafe": a 5xx or timeout is when Google may already have
 * billed the call, so it is never retried and its error says how to check (429 is still retried). Free countTokens
 * stays "idempotent". The urlContext tool needs GEMINI_TOOL_ALLOW_URL_CONTEXT=1 for agents (lib/url-context.mjs).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createUploadFileOperation } from "./lib/upload-file.mjs";
import { guardUrlContext, URL_CONTEXT_ENV } from "./lib/url-context.mjs";

const GENERATION_TIMEOUT_MS = 280000;
const PAID_CHECK_HINT = "the call may have been billed (on a paid tier); check usage in Google AI Studio before retrying";
const TASK_TYPES = ["SEMANTIC_SIMILARITY", "CLASSIFICATION", "CLUSTERING", "RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY", "QUESTION_ANSWERING", "FACT_VERIFICATION", "CODE_RETRIEVAL_QUERY"];
const modelPathParam = (example) => ({ in: "path", type: "string", required: true, description: `Model id without the models/ prefix, e.g. ${example}` });
const contentsParam = {
  in: "body",
  type: "array",
  items: { type: "object" },
  required: true,
  description: 'Conversation, e.g. [{"role":"user","parts":[{"text":"Hi"}]}]; files as {"fileData":{"fileUri":...,"mimeType":...}}',
};
const fileIdParam = { file_id: { in: "path", type: "string", required: true, description: 'File id: the part after "files/" in the file name' } };

const generateContent = {
  name: "generate_content",
  title: "Generate content",
  description: "Ask Gemini (not streamed); the text is in candidates[0].content.parts[].text. Check candidates[0].finishReason and promptFeedback.blockReason",
  method: "POST",
  path: "/models/{model}:generateContent",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: modelPathParam("gemini-2.5-flash"),
    contents: contentsParam,
    system_instruction: { in: "body", type: "object", wireName: "systemInstruction", description: '{"parts":[{"text":"You are ..."}]}' },
    generation_config: {
      in: "body",
      type: "object",
      wireName: "generationConfig",
      description: '{"maxOutputTokens":..,"temperature":..,"responseMimeType":"application/json","responseSchema":{..},"thinkingConfig":{..}}',
    },
    tools: { in: "body", type: "array", items: { type: "object" }, description: 'Tools, e.g. [{"functionDeclarations":[..]}] or [{"googleSearch":{}}]' },
    tool_config: { in: "body", type: "object", wireName: "toolConfig", description: "Function calling mode" },
    safety_settings: { in: "body", type: "array", items: { type: "object" }, wireName: "safetySettings", description: "[{category, threshold}]" },
    cached_content: { in: "body", type: "string", wireName: "cachedContent", description: "cachedContents/... to use as a prefix" },
  },
};

const countTokens = {
  name: "count_tokens",
  title: "Count tokens",
  description: "Count the tokens of contents for a model (free)",
  method: "POST",
  path: "/models/{model}:countTokens",
  write: "idempotent",
  params: { model: modelPathParam("gemini-2.5-flash"), contents: contentsParam },
};

const embedContent = {
  name: "embed_content",
  title: "Embed content",
  description: "Embed one text; the vector is in embedding.values",
  method: "POST",
  path: "/models/{model}:embedContent",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  toolOutput: { maxChars: 20000 },
  params: {
    model: modelPathParam("gemini-embedding-001"),
    content: { in: "body", type: "object", required: true, description: '{"parts":[{"text":"..."}]}' },
    task_type: { in: "body", type: "string", enum: TASK_TYPES, wireName: "taskType", description: "What the embedding is for" },
    document_title: { in: "body", type: "string", wireName: "title", description: "Document title, sent as `title` (RETRIEVAL_DOCUMENT only)" },
    output_dimensionality: { in: "body", type: "integer", min: 1, wireName: "outputDimensionality", description: "Shorter vectors, e.g. 768" },
  },
};

const batchEmbedContents = {
  name: "batch_embed_contents",
  title: "Embed many texts",
  description: "Embed up to 100 texts in one call; embeddings[i].values belongs to requests[i]",
  method: "POST",
  path: "/models/{model}:batchEmbedContents",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  toolOutput: { maxChars: 20000 },
  params: {
    model: modelPathParam("gemini-embedding-001"),
    requests: {
      in: "body",
      type: "array",
      items: { type: "object" },
      required: true,
      maxItems: 100,
      description: 'Each {"model":"models/gemini-embedding-001","content":{"parts":[{"text":"..."}]},"taskType":...}',
    },
  },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List Gemini models with their token limits and supportedGenerationMethods",
  path: "/models",
  response: { dataPath: "models", cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 1000 },
};

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "Get one model's token limits, defaults and supported methods",
  path: "/models/{model}",
  params: { model: modelPathParam("gemini-2.5-flash") },
};

const listFiles = {
  name: "list_files",
  title: "List files",
  description: "List files uploaded with upload_file (kept 48 hours)",
  path: "/files",
  response: { dataPath: "files", cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 100 },
};

const getFile = {
  name: "get_file",
  title: "Get file",
  description: "Get a file's metadata and state (PROCESSING, ACTIVE, FAILED); use it in prompts once ACTIVE",
  path: "/files/{file_id}",
  params: fileIdParam,
};

const deleteFile = {
  name: "delete_file",
  title: "Delete file",
  description: "Delete an uploaded file",
  method: "DELETE",
  path: "/files/{file_id}",
  write: "idempotent",
  nodeOnly: true,
  params: fileIdParam,
};

const restDefinition = defineRestPlugin({
  name: "gemini",
  version: "0.1.0",
  description: "Google Gemini API: generateContent (non-streaming), countTokens, embeddings, models and files",
  apiName: "Gemini API",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  auth: { type: "header", header: "x-goog-api-key", env: "GEMINI_API_KEY" },
  limits: { timeout_ms: 600000 },
  // Google errors are {"error": {"code", "message", "status", "details": [{"reason": "API_KEY_INVALID", ...}]}}; an
  // invalid key is a 400 INVALID_ARGUMENT, so the ErrorInfo reason decides the kind.
  errors: {
    messagePath: "error.message",
    codePath: "error.details.0.reason",
    kindByCode: {
      API_KEY_INVALID: "auth_error",
      API_KEY_EXPIRED: "auth_error",
      API_KEY_SERVICE_BLOCKED: "permission_denied",
      SERVICE_DISABLED: "permission_denied",
      ACCESS_TOKEN_SCOPE_INSUFFICIENT: "permission_denied",
      RATE_LIMIT_EXCEEDED: "rate_limited",
    },
  },
  apiRequest: { examplePath: "/models" },
  operations: [generateContent, countTokens, embedContent, batchEmbedContents, listModels, getModel, listFiles, getFile, deleteFile],
});

export const pluginDefinition = {
  ...restDefinition,
  extraEnv: [...restDefinition.extraEnv, "GEMINI_UPLOAD_DIR", URL_CONTEXT_ENV],
  operations: [...restDefinition.operations.map((operation) => (operation.name === "generate_content" ? guardUrlContext(operation) : operation)), createUploadFileOperation()],
};
