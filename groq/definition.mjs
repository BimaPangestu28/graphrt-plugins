/**
 * groq plugin definition: the OpenAI-compatible Groq API (https://console.groq.com/docs/api-reference) for workflows
 * that need a fast second model: chat completions (non-streaming), Whisper transcription and translation, text to
 * speech, models, files and the Batch API. Built with the declarative REST layer (docs/declarative-plugins.md).
 * Paths and params follow the official groq-python SDK.
 *
 * Retries: chat, transcription, translation and speech are paid, so they are "unsafe": a 5xx or timeout is when Groq
 * may already have billed the call, so it is never retried and its error says how to check (429 is still retried).
 * File uploads and batch creation are "unsafe" too; batch creation needs GROQ_TOOL_ALLOW_BATCH=1 for agents. Deletes
 * and batch cancellation are node only.
 *
 * Model ids with a slash (openai/gpt-oss-120b) are sent as one encoded segment (openai%2Fgpt-oss-120b) in get_model,
 * the same as the official groq-python SDK's path_template, which quotes "/".
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const GENERATION_TIMEOUT_MS = 280000;
const PAID_CHECK_HINT = "the call may have been billed (on a paid plan); check usage in the Groq console before retrying";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const audioUpload = { fileDirEnv: "GROQ_UPLOAD_DIR", maxFileBytes: MAX_AUDIO_BYTES };
const audioParams = (defaultModel) => ({
  model: { in: "body", type: "string", default: defaultModel, description: "whisper-large-v3-turbo (fast) or whisper-large-v3 (accurate)" },
  file: { in: "body", type: "string", file: true, description: "Audio file (flac, mp3, mp4, m4a, ogg, wav, webm; max 25 MB). Give file or url" },
  url: { in: "body", type: "string", description: "Public audio URL Groq fetches itself, instead of file" },
  prompt: { in: "body", type: "string", description: "Spelling hints or the previous segment's text" },
  response_format: { in: "body", type: "string", enum: ["json", "text", "verbose_json"], default: "json", description: "verbose_json adds segments and timestamps" },
  temperature: { in: "body", type: "number", min: 0, max: 1, description: "Sampling temperature" },
});
const fileIdParam = { file_id: { in: "path", type: "string", required: true, description: "File id (file_...)" } };
const batchIdParam = { batch_id: { in: "path", type: "string", required: true, description: "Batch id (batch_...)" } };

const createChatCompletion = {
  name: "create_chat_completion",
  title: "Create chat completion",
  description: "Generate a chat completion on Groq (not streamed); the answer is in choices[0].message.content",
  method: "POST",
  path: "/chat/completions",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: { in: "body", type: "string", required: true, description: "Model id from list_models, e.g. llama-3.3-70b-versatile or openai/gpt-oss-120b" },
    messages: { in: "body", type: "array", items: { type: "object" }, required: true, description: 'Messages, e.g. [{"role":"user","content":"Hi"}]' },
    max_completion_tokens: { in: "body", type: "integer", min: 1, description: "Cap on generated tokens" },
    temperature: { in: "body", type: "number", min: 0, max: 2, description: "Sampling temperature" },
    response_format: { in: "body", type: "object", description: '{"type":"json_object"} or {"type":"json_schema","json_schema":{...}}' },
    tools: { in: "body", type: "array", items: { type: "object" }, description: "Function tool definitions" },
    reasoning_effort: { in: "body", type: "string", enum: ["none", "default", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Reasoning models only" },
    reasoning_format: { in: "body", type: "string", enum: ["hidden", "raw", "parsed"], description: "How reasoning is returned (reasoning models)" },
    seed: { in: "body", type: "integer", description: "Best-effort deterministic sampling" },
    stop: { in: "body", type: "array", items: { type: "string" }, maxItems: 4, description: "Stop sequences" },
  },
  constants: { body: { stream: false } },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List the models available on Groq, with context_window",
  path: "/models",
  response: { dataPath: "data" },
};

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "Get one model's owner, context window and status",
  path: "/models/{model}",
  params: { model: { in: "path", type: "string", required: true, description: "Model id; ids with a slash (openai/gpt-oss-120b) are sent encoded as one segment, like the official SDK" } },
};

const transcribeAudio = {
  name: "transcribe_audio",
  title: "Transcribe audio",
  description: "Speech to text in the spoken language with Whisper; the text is in text",
  method: "POST",
  path: "/audio/transcriptions",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  bodyMode: "multipart",
  multipart: audioUpload,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: { ...audioParams("whisper-large-v3-turbo"), language: { in: "body", type: "string", description: "ISO-639-1 code of the audio, e.g. en, id (improves accuracy)" } },
};

const translateAudio = {
  name: "translate_audio",
  title: "Translate audio to English",
  description: "Speech in any language to English text with Whisper",
  method: "POST",
  path: "/audio/translations",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  bodyMode: "multipart",
  multipart: audioUpload,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: audioParams("whisper-large-v3"),
};

const createSpeech = {
  name: "create_speech",
  title: "Text to speech",
  description: "Turn text into speech and save the audio into $GROQ_OUTPUT_DIR",
  method: "POST",
  path: "/audio/speech",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    model: { in: "body", type: "string", required: true, description: "TTS model from the Groq text-to-speech docs" },
    input: { in: "body", type: "string", required: true, minLength: 1, description: "Text to speak" },
    voice: { in: "body", type: "string", required: true, description: "Voice name for the model" },
    response_format: { in: "body", type: "string", enum: ["flac", "mp3", "mulaw", "ogg", "wav"], default: "wav", description: "Audio format" },
    sample_rate: { in: "body", type: "integer", enum: [8000, 16000, 22050, 24000, 32000, 44100, 48000], description: "Sample rate in Hz" },
    speed: { in: "body", type: "number", min: 0.5, max: 5, description: "Speaking speed" },
  },
  response: { binary: { envDir: "GROQ_OUTPUT_DIR", maxBytes: 50 * 1024 * 1024 } },
};

const listFiles = {
  name: "list_files",
  title: "List files",
  description: "List uploaded files",
  path: "/files",
  response: { dataPath: "data" },
};

const uploadFile = {
  name: "upload_file",
  title: "Upload file",
  description: "Upload a .jsonl batch input file and get its file id",
  method: "POST",
  path: "/files",
  write: "unsafe",
  checkHint: "list_files and look for the file name",
  bodyMode: "multipart",
  multipart: { fileDirEnv: "GROQ_UPLOAD_DIR", maxFileBytes: 100 * 1024 * 1024 },
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    file: { in: "body", type: "string", file: true, required: true, description: "JSONL file (max 100 MB here)" },
    purpose: { in: "body", type: "string", enum: ["batch"], default: "batch", description: "Only batch is supported" },
  },
};

const getFile = { name: "get_file", title: "Get file", description: "Get an uploaded file's metadata", path: "/files/{file_id}", params: fileIdParam };

const downloadFileContent = {
  name: "download_file_content",
  title: "Download file content",
  description: "Save a file's content (e.g. a batch's output_file_id) into $GROQ_OUTPUT_DIR",
  path: "/files/{file_id}/content",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: fileIdParam,
  response: { binary: { envDir: "GROQ_OUTPUT_DIR", maxBytes: 200 * 1024 * 1024 } },
};

const deleteFile = { name: "delete_file", title: "Delete file", description: "Delete an uploaded file", method: "DELETE", path: "/files/{file_id}", write: "idempotent", nodeOnly: true, params: fileIdParam };

const createBatch = {
  name: "create_batch",
  title: "Create batch",
  description: "Start a batch job over an uploaded .jsonl file (cheaper, finishes within the completion window); poll it with get_batch",
  method: "POST",
  path: "/batches",
  write: "unsafe",
  checkHint: "list_batches and look for the input_file_id",
  toolPolicy: "optIn:GROQ_TOOL_ALLOW_BATCH",
  params: {
    input_file_id: { in: "body", type: "string", required: true, description: "File id of the .jsonl input" },
    endpoint: { in: "body", type: "string", enum: ["/v1/chat/completions"], default: "/v1/chat/completions", description: "Endpoint every line calls" },
    completion_window: { in: "body", type: "string", default: "24h", description: "24h up to 7d" },
    metadata: { in: "body", type: "object", description: "String key/value pairs" },
  },
};

const getBatch = { name: "get_batch", title: "Get batch", description: "Get a batch's status and output_file_id", path: "/batches/{batch_id}", params: batchIdParam };
const listBatches = { name: "list_batches", title: "List batches", description: "List batches", path: "/batches", response: { dataPath: "data" } };
const cancelBatch = {
  name: "cancel_batch",
  title: "Cancel batch",
  description: "Cancel a running batch (finished requests are still billed)",
  method: "POST",
  path: "/batches/{batch_id}/cancel",
  write: "idempotent",
  nodeOnly: true,
  params: batchIdParam,
};

export const pluginDefinition = defineRestPlugin({
  name: "groq",
  version: "0.1.0",
  description: "Groq API: fast chat completions (non-streaming), Whisper transcription, text to speech, models, files and batches",
  apiName: "Groq API",
  baseUrl: "https://api.groq.com/openai/v1",
  auth: { type: "bearer", env: "GROQ_API_KEY" },
  limits: { timeout_ms: 600000 },
  // OpenAI-style errors: {"error": {"message", "type", "code"}}.
  errors: { messagePath: "error.message", codePath: "error.code", kindByCode: { invalid_api_key: "auth_error", model_not_found: "not_found", rate_limit_exceeded: "rate_limited" } },
  apiRequest: { examplePath: "/models" },
  operations: [
    createChatCompletion,
    listModels,
    getModel,
    transcribeAudio,
    translateAudio,
    createSpeech,
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
