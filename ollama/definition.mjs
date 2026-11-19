/**
 * ollama plugin definition: the local Ollama server API (https://github.com/ollama/ollama/blob/main/docs/api.md)
 * for workflows that run a second model on your own machine: generate, chat and embed (non-streaming), and list,
 * show, pull, copy and delete local models. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * The server is OLLAMA_URL (default http://127.0.0.1:11434). The layer allows plain http only on localhost, so a
 * remote server must be https. Ollama has no auth of its own; for a server behind an authenticating proxy,
 * OLLAMA_API_KEY is sent as a bearer token (lib/ollama-extras.mjs), otherwise nothing is sent but the request.
 * Generation runs on your own machine and costs nothing, so it stays "idempotent" and is retried.
 * Pull, copy and delete change what is installed, so they are node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { acceptThinkLevels, API_KEY_ENV, authorizeOptionalBearer } from "./lib/ollama-extras.mjs";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const GENERATION_TIMEOUT_MS = 600000;
const PULL_TIMEOUT_MS = 1780000;
const modelParam = { in: "body", type: "string", required: true, description: "Local model name, e.g. llama3.2 or qwen3:8b (see list_models)" };
const generationParams = {
  format: { in: "body", type: "object", description: 'JSON schema the output must follow, e.g. {"type":"object","properties":{...}}' },
  options: { in: "body", type: "object", description: 'Model options, e.g. {"temperature":0,"num_ctx":8192,"num_predict":512}' },
  // The schema is widened to boolean or level by acceptThinkLevels.
  think: { in: "body", type: "string", description: "Thinking models: true/false or low/medium/high" },
  keep_alive: { in: "body", type: "string", description: 'How long the model stays loaded, e.g. "5m", "1h" or "0"' },
};

/**
 * Resolves the Ollama base URL from OLLAMA_URL.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL without a trailing slash (string)
 * @throws Error - When OLLAMA_URL is not an http(s) URL with only a scheme, host and port
 */
export function resolveOllamaUrl(environment) {
  const configuredUrl = environment.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL;
  const parsedUrl = new URL(configuredUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("OLLAMA_URL must be an http:// (localhost only) or https:// URL");
  if (parsedUrl.search || parsedUrl.hash) throw new Error("OLLAMA_URL must not have a query or fragment");
  return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, "")}`;
}

const generate = {
  name: "generate",
  title: "Generate",
  description: "Complete a prompt with a local model (not streamed); the text is in response",
  method: "POST",
  path: "/api/generate",
  write: "idempotent",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: modelParam,
    prompt: { in: "body", type: "string", required: true, description: "Prompt" },
    system: { in: "body", type: "string", description: "System prompt (overrides the Modelfile's)" },
    suffix: { in: "body", type: "string", description: "Text after the completion (fill in the middle)" },
    images: { in: "body", type: "array", items: { type: "string" }, description: "Base64 images for vision models" },
    raw: { in: "body", type: "boolean", description: "Send the prompt without the model's template" },
    ...generationParams,
  },
  constants: { body: { stream: false } },
};

const chat = {
  name: "chat",
  title: "Chat",
  description: "Chat with a local model (not streamed); the reply is in message.content (tool calls in message.tool_calls)",
  method: "POST",
  path: "/api/chat",
  write: "idempotent",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: modelParam,
    messages: { in: "body", type: "array", items: { type: "object" }, required: true, description: 'Messages, e.g. [{"role":"user","content":"Hi"}]' },
    tools: { in: "body", type: "array", items: { type: "object" }, description: "Function tool definitions (models with tool support)" },
    ...generationParams,
  },
  constants: { body: { stream: false } },
};

const embed = {
  name: "embed",
  title: "Embed",
  description: "Embed texts with a local embedding model; embeddings[i] belongs to input[i]",
  method: "POST",
  path: "/api/embed",
  write: "idempotent",
  timeoutMs: GENERATION_TIMEOUT_MS,
  toolOutput: { maxChars: 20000 },
  params: {
    model: { ...modelParam, description: "Embedding model, e.g. nomic-embed-text or embeddinggemma" },
    input: { in: "body", type: "array", items: { type: "string" }, required: true, description: "Texts to embed" },
    truncate: { in: "body", type: "boolean", description: "Cut inputs to the context length (default true; false errors instead)" },
    dimensions: { in: "body", type: "integer", min: 1, description: "Vector size, for models that support it" },
    keep_alive: generationParams.keep_alive,
  },
};

const listModels = { name: "list_models", title: "List models", description: "List the models installed locally, with size and details", path: "/api/tags", response: { dataPath: "models" } };

const showModel = {
  name: "show_model",
  title: "Show model",
  description: "Show a local model's details, parameters, template, license and capabilities",
  method: "POST",
  path: "/api/show",
  write: "idempotent",
  params: { model: modelParam, verbose: { in: "body", type: "boolean", description: "Include the full tokenizer data (large)" } },
};

const listRunningModels = { name: "list_running_models", title: "List running models", description: "List models loaded in memory now", path: "/api/ps", response: { dataPath: "models" } };

const getVersion = { name: "get_version", title: "Get version", description: "Get the Ollama server version", path: "/api/version" };

const pullModel = {
  name: "pull_model",
  title: "Pull model",
  description: "Download a model from the Ollama library and wait until it is installed (can be many GB)",
  method: "POST",
  path: "/api/pull",
  write: "idempotent",
  nodeOnly: true,
  timeoutMs: PULL_TIMEOUT_MS,
  params: { model: { ...modelParam, description: "Library model name, e.g. llama3.2:3b" } },
  constants: { body: { stream: false } },
};

const copyModel = {
  name: "copy_model",
  title: "Copy model",
  description: "Copy a local model to a new name (overwrites a model with that name)",
  method: "POST",
  path: "/api/copy",
  write: "idempotent",
  nodeOnly: true,
  params: {
    source: { in: "body", type: "string", required: true, description: "Existing model" },
    destination: { in: "body", type: "string", required: true, description: "New name" },
  },
};

const deleteModel = {
  name: "delete_model",
  title: "Delete model",
  description: "Delete a local model and free its disk space",
  method: "DELETE",
  path: "/api/delete",
  write: "idempotent",
  nodeOnly: true,
  params: { model: modelParam },
};

const restDefinition = defineRestPlugin({
  name: "ollama",
  version: "0.1.0",
  description: "Ollama on your own machine: generate, chat and embed (non-streaming), list, show, pull, copy and delete local models",
  apiName: "Ollama API",
  extraEnv: ["OLLAMA_URL", API_KEY_ENV],
  baseUrl: resolveOllamaUrl,
  auth: { type: "custom", authorize: authorizeOptionalBearer },
  // Pulls of large models need a long host timeout.
  limits: { timeout_ms: 1800000 },
  errors: { messagePath: "error" },
  apiRequest: { examplePath: "/api/tags" },
  operations: [generate, chat, embed, listModels, showModel, listRunningModels, getVersion, pullModel, copyModel, deleteModel],
});

export const pluginDefinition = {
  ...restDefinition,
  operations: restDefinition.operations.map((operation) => (["generate", "chat"].includes(operation.name) ? acceptThinkLevels(operation) : operation)),
};
