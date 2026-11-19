/**
 * deepgram plugin definition: pre-recorded speech to text (by URL or local file), Aura text to speech, text
 * intelligence, models and project usage through the Deepgram API (https://developers.deepgram.com/reference).
 * Built with the declarative REST layer (docs/declarative-plugins.md); `transcribe_file` sends the audio as the raw
 * request body (bodyMode "file"). Every billed call is `write: "unsafe"`: it is never retried after a timeout or 5xx,
 * because Deepgram may have processed and billed it.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { requireExactlyOne } from "./lib/require-one-of.mjs";

const OUTPUT_DIR_ENV = "DEEPGRAM_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "DEEPGRAM_UPLOAD_DIR";
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const LISTEN_TIMEOUT_MS = 280000;

const PAID_CALL = { write: "unsafe", checkHint: "list_project_requests for the project (endpoint and time) to see whether it was processed and billed" };

const flag = (description) => ({ in: "query", type: "boolean", description });

// Query params shared by transcribe_url and transcribe_file.
const LISTEN_QUERY_PARAMS = {
  model: { in: "query", type: "string", default: "nova-3", description: "Model, e.g. nova-3, nova-3-medical, nova-2 (Deepgram's own default is base)" },
  language: { in: "query", type: "string", description: "BCP-47 language, e.g. en, id; multi for multilingual nova-3 (default en)" },
  detect_language: flag("Detect the dominant language"),
  smart_format: { in: "query", type: "boolean", default: true, description: "Punctuation, paragraphs and readable numbers, dates and currency" },
  punctuate: flag("Add punctuation and capitalization"),
  diarize: flag("Label speakers on each word"),
  paragraphs: flag("Split the transcript into paragraphs"),
  utterances: flag("Split into utterances (speech segments) with timings"),
  summarize: { in: "query", type: "string", enum: ["v2"], description: "v2: add a summary (English)" },
  topics: flag("Detect topics (English)"),
  intents: flag("Detect intents (English)"),
  sentiment: flag("Sentiment per segment (English)"),
  detect_entities: flag("Detect entities such as names and places"),
  keyterm: { in: "query", type: "array", items: { type: "string" }, maxItems: 100, style: "repeat", description: "Key terms to boost (nova-3 only)" },
  redact: { in: "query", type: "array", items: { type: "string", enum: ["pci", "pii", "numbers"] }, maxItems: 3, style: "repeat", description: "Redact pci, pii and/or numbers" },
  numerals: flag("Write numbers as digits"),
  profanity_filter: flag("Mask profanity"),
  filler_words: flag("Keep filler words such as uh and um"),
  multichannel: flag("Transcribe each audio channel separately"),
  tag: { in: "query", type: "array", items: { type: "string" }, maxItems: 10, style: "repeat", description: "Tags for usage reports" },
};

const transcribeUrl = {
  name: "transcribe_url",
  title: "Transcribe audio URL",
  description: "Transcribe pre-recorded audio or video that Deepgram fetches from a public URL (billed per minute of audio)",
  method: "POST",
  path: "/v1/listen",
  ...PAID_CALL,
  timeoutMs: LISTEN_TIMEOUT_MS,
  params: {
    url: { in: "body", type: "string", required: true, minLength: 1, description: "Public http(s) URL of the media" },
    ...LISTEN_QUERY_PARAMS,
  },
};

const transcribeFile = {
  name: "transcribe_file",
  title: "Transcribe audio file",
  description: "Transcribe a pre-recorded audio or video file (an https URL that this plugin downloads, or a file inside DEEPGRAM_UPLOAD_DIR; billed per minute of audio)",
  method: "POST",
  path: "/v1/listen",
  ...PAID_CALL,
  bodyMode: "file",
  fileBody: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
  // One budget for downloading an https input and uploading it.
  timeoutMs: LISTEN_TIMEOUT_MS,
  params: {
    file: { in: "body", type: "string", file: true, required: true, description: "Audio or video file, up to 200 MB" },
    ...LISTEN_QUERY_PARAMS,
  },
};

const textToSpeech = {
  name: "text_to_speech",
  title: "Text to speech",
  description: "Turn text (up to 2000 characters) into speech with an Aura voice and save the audio file in DEEPGRAM_OUTPUT_DIR (billed per character)",
  method: "POST",
  path: "/v1/speak",
  ...PAID_CALL,
  timeoutMs: 110000,
  params: {
    text: { in: "body", type: "string", required: true, minLength: 1, description: "Text to speak (max 2000 characters)" },
    model: { in: "query", type: "string", default: "aura-2-thalia-en", description: "Aura voice model, e.g. aura-2-thalia-en, aura-2-andromeda-en (see list_models tts)" },
    encoding: { in: "query", type: "string", enum: ["linear16", "flac", "mulaw", "alaw", "mp3", "opus", "aac"], description: "Audio encoding (default mp3)" },
    container: { in: "query", type: "string", enum: ["none", "wav", "ogg"], description: "Container: wav for linear16/mulaw/alaw, ogg for opus" },
    sample_rate: { in: "query", type: "integer", description: "Sample rate in Hz, e.g. 24000 (depends on the encoding)" },
    bit_rate: { in: "query", type: "integer", description: "Bit rate in bps, e.g. 48000 (mp3: 32000 or 48000)" },
  },
  response: { binary: { envDir: OUTPUT_DIR_ENV, maxBytes: 50 * 1024 * 1024 } },
};

const analyzeText = {
  name: "analyze_text",
  title: "Analyze text",
  description: "Summarize text and detect topics, intents and sentiment (exactly one of text or url; billed per token)",
  method: "POST",
  path: "/v1/read",
  ...PAID_CALL,
  params: {
    text: { in: "body", type: "string", minLength: 1, description: "Text to analyze (or url)" },
    url: { in: "body", type: "string", minLength: 1, description: "URL of a text file to analyze (or text)" },
    language: { in: "query", type: "string", default: "en", description: "Language of the text (intelligence features support en)" },
    summarize: flag("Add a summary"),
    topics: flag("Detect topics"),
    intents: flag("Detect intents"),
    sentiment: flag("Sentiment per segment and on average"),
  },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List the speech-to-text (stt) and text-to-speech (tts) models with languages and versions",
  path: "/v1/models",
  params: { include_outdated: flag("Also list outdated model versions") },
};

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "Get one model by its uuid",
  path: "/v1/models/{model_id}",
  params: { model_id: { in: "path", type: "string", required: true, description: "Model uuid from list_models" } },
};

const listProjects = {
  name: "list_projects",
  title: "List projects",
  description: "List the projects the key can access (project_id and name)",
  path: "/v1/projects",
  response: { dataPath: "projects" },
};

const getProjectBalances = {
  name: "get_project_balances",
  title: "Get balances",
  description: "Remaining credit balances of a project",
  path: "/v1/projects/{project_id}/balances",
  params: { project_id: { in: "path", type: "string", required: true, description: "Project id from list_projects" } },
  response: { dataPath: "balances" },
};

const listProjectRequests = {
  name: "list_project_requests",
  title: "List requests",
  description: "List a project's API requests (newest first) with endpoint, status and response summary",
  path: "/v1/projects/{project_id}/requests",
  params: {
    project_id: { in: "path", type: "string", required: true, description: "Project id from list_projects" },
    start: { in: "query", type: "string", description: "From this date or time (YYYY-MM-DD or ISO 8601)" },
    end: { in: "query", type: "string", description: "Until this date or time (YYYY-MM-DD or ISO 8601)" },
    endpoint: { in: "query", type: "string", enum: ["listen", "read", "speak", "agent"], description: "Only this endpoint" },
    method: { in: "query", type: "string", enum: ["sync", "async", "streaming"], description: "Only this request method" },
    status: { in: "query", type: "string", enum: ["succeeded", "failed"], description: "Only this status" },
    request_id: { in: "query", type: "string", description: "Only this request id" },
  },
  response: { dataPath: "requests", pagePagination: { pageParam: "page", sizeParam: "limit", firstPage: 0 }, maxLimit: 1000 },
};

const restDefinition = defineRestPlugin({
  name: "deepgram",
  version: "0.1.0",
  description: "Deepgram: pre-recorded transcription by URL or file, Aura text to speech saved as audio files, text intelligence, models and project usage",
  apiName: "Deepgram API",
  baseUrl: "https://api.deepgram.com",
  auth: { type: "header", header: "Authorization", prefix: "Token ", env: "DEEPGRAM_API_KEY" },
  // Transcription requests take up to 280 s; https inputs (up to 200 MB) get the remaining ~310 s to download first.
  limits: { timeout_ms: 600000 },
  // {"err_code", "err_msg", "request_id"}; newer errors use {"category", "message", "details"}.
  errors: {
    messagePath: ["err_msg", "message", "details"],
    codePath: "err_code",
    kindByCode: {
      INVALID_AUTH: "auth_error",
      INSUFFICIENT_PERMISSIONS: "permission_denied",
      TOO_MANY_REQUESTS: "rate_limited",
      PAYLOAD_TOO_LARGE: "invalid_input",
      INVALID_QUERY_PARAMETER: "invalid_input",
      PROJECT_NOT_FOUND: "not_found",
    },
  },
  apiRequest: { examplePath: "/v1/projects" },
  operations: [transcribeUrl, transcribeFile, textToSpeech, analyzeText, listModels, getModel, listProjects, getProjectBalances, listProjectRequests],
});

export const pluginDefinition = requireExactlyOne(restDefinition, "analyze_text", ["text", "url"]);
