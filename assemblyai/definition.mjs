/**
 * assemblyai plugin definition: file upload, transcription jobs (create and wait), transcripts and their
 * sentences, paragraphs, subtitles and word search, plus the LLM Gateway that replaced LeMUR, through the
 * AssemblyAI API (https://www.assemblyai.com/docs/api-reference). Built with the declarative REST layer
 * (docs/declarative-plugins.md). `upload_file` sends the file as the raw request body (bodyMode "file").
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const REGION_ENV = "ASSEMBLYAI_REGION";
const UPLOAD_DIR_ENV = "ASSEMBLYAI_UPLOAD_DIR";
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const HOST_TIMEOUT_MS = 900000;

/**
 * Picks the host for the region in $ASSEMBLYAI_REGION ("us", the default, or "eu").
 *
 * @param environment - Environment variables (object)
 * @param hostPrefix - "api" or "llm-gateway" (string)
 * @returns Base URL, e.g. "https://api.eu.assemblyai.com" (string)
 * @throws Error - When the region is not us or eu
 */
function resolveRegionalBaseUrl(environment, hostPrefix) {
  const region = (environment[REGION_ENV] ?? "us").trim().toLowerCase() || "us";
  if (region !== "us" && region !== "eu") throw new Error(`${REGION_ENV} must be us or eu`);
  return region === "eu" ? `https://${hostPrefix}.eu.assemblyai.com` : `https://${hostPrefix}.assemblyai.com`;
}

const transcriptIdParam = { in: "path", type: "string", required: true, description: "Transcript id" };
const flag = (description) => ({ in: "body", type: "boolean", description });
const stringList = (description, maxItems) => ({ in: "body", type: "array", items: { type: "string" }, maxItems, description });

const TRANSCRIPT_OPTIONS = {
  audio_url: { in: "body", type: "string", required: true, minLength: 1, description: "Public URL of the audio/video, or the upload_url from upload_file" },
  speech_models: stringList('Models in priority order, e.g. ["assemblyai-stt-3-7", "universal-2"] (default assemblyai-stt-3-7)', 5),
  language_code: { in: "body", type: "string", description: "Language code, e.g. en, id; detected automatically when omitted" },
  language_detection: flag("Detect the language (do not combine with language_code)"),
  punctuate: flag("Add punctuation (default true)"),
  format_text: flag("Format text: casing, numbers (default true)"),
  speaker_labels: flag("Label speakers (diarization)"),
  speakers_expected: { in: "body", type: "integer", min: 1, max: 20, description: "Expected number of speakers (with speaker_labels)" },
  multichannel: flag("Transcribe each channel separately"),
  keyterms_prompt: stringList("Domain words or phrases to boost (up to 1000 on stt-3-7, 200 on universal-2)", 1000),
  prompt: { in: "body", type: "string", description: "Free-text context to guide the transcription (assemblyai-stt-3-7 only)" },
  sentiment_analysis: flag("Sentiment per sentence"),
  entity_detection: flag("Detect named entities"),
  iab_categories: flag("Topic detection (IAB categories)"),
  auto_highlights: flag("Key phrases"),
  content_safety: flag("Content moderation labels"),
  redact_pii: flag("Redact PII in the text (needs redact_pii_policies)"),
  redact_pii_policies: stringList("PII types to redact, e.g. person_name, phone_number, email_address, credit_card_number", 60),
  redact_pii_sub: { in: "body", type: "string", enum: ["hash", "entity_name"], description: "How redacted PII is replaced (default hash)" },
  audio_start_from: { in: "body", type: "integer", min: 0, description: "Start transcribing at this millisecond" },
  audio_end_at: { in: "body", type: "integer", min: 0, description: "Stop transcribing at this millisecond" },
};

const uploadFile = {
  name: "upload_file",
  title: "Upload file",
  description: "Upload a local audio/video file (inside ASSEMBLYAI_UPLOAD_DIR) or an https URL to AssemblyAI; returns an upload_url for transcribe",
  method: "POST",
  path: "/v2/upload",
  // Free, and it only stores a private copy: repeating it is harmless, so it may be retried.
  write: "idempotent",
  bodyMode: "file",
  fileBody: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
  contentType: "application/octet-stream",
  // One budget for downloading an https input and uploading it.
  timeoutMs: 280000,
  params: { file: { in: "body", type: "string", file: true, required: true, description: "Audio or video file, up to 200 MB" } },
};

const transcribe = {
  name: "transcribe",
  title: "Transcribe audio",
  description: "Start a transcription and wait for it (wait: false returns the id at once; billed per hour of audio plus enabled features)",
  method: "POST",
  path: "/v2/transcript",
  write: "unsafe",
  checkHint: "list_transcripts and look for the audio_url",
  params: TRANSCRIPT_OPTIONS,
  job: {
    idPath: "id",
    poll: { method: "GET", path: "/v2/transcript/{id}" },
    statusPath: "status",
    doneValues: ["completed"],
    failedValues: ["error"],
    errorPath: "error",
    intervalMs: 5000,
    timeoutMs: HOST_TIMEOUT_MS - 15000,
  },
};

const getTranscript = {
  name: "get_transcript",
  title: "Get transcript",
  description: "Get a transcript: status (queued, processing, completed, error), text, words, utterances and feature results",
  path: "/v2/transcript/{transcript_id}",
  params: { transcript_id: transcriptIdParam },
};

const listTranscripts = {
  name: "list_transcripts",
  title: "List transcripts",
  description: "List transcripts of the last 30 days, newest first (id, status, audio_url, created)",
  path: "/v2/transcript",
  params: {
    status: { in: "query", type: "string", enum: ["queued", "processing", "completed", "error"], description: "Only transcripts with this status" },
    created_on: { in: "query", type: "string", description: "Only transcripts created on this date (YYYY-MM-DD)" },
  },
  // Newest first: prev_url is the page of older transcripts.
  response: { dataPath: "transcripts", nextUrlPath: "page_details.prev_url", limitParam: "limit", maxLimit: 200 },
};

const getSentences = {
  name: "get_sentences",
  title: "Get sentences",
  description: "A completed transcript split into sentences with timings, confidence and speaker",
  path: "/v2/transcript/{transcript_id}/sentences",
  params: { transcript_id: transcriptIdParam },
  response: { dataPath: "sentences" },
};

const getParagraphs = {
  name: "get_paragraphs",
  title: "Get paragraphs",
  description: "A completed transcript split into paragraphs with timings and confidence",
  path: "/v2/transcript/{transcript_id}/paragraphs",
  params: { transcript_id: transcriptIdParam },
  response: { dataPath: "paragraphs" },
};

const getSubtitles = {
  name: "get_subtitles",
  title: "Get subtitles",
  description: "Export a completed transcript as SRT or WebVTT subtitles (returned as {text})",
  path: "/v2/transcript/{transcript_id}/{subtitle_format}",
  params: {
    transcript_id: transcriptIdParam,
    subtitle_format: { in: "path", type: "string", required: true, enum: ["srt", "vtt"], description: "srt or vtt" },
    chars_per_caption: { in: "query", type: "integer", min: 1, description: "Maximum characters per caption" },
  },
};

const searchWords = {
  name: "search_words",
  title: "Search words",
  description: "Find words or phrases in a completed transcript, with counts and timestamps",
  path: "/v2/transcript/{transcript_id}/word-search",
  params: {
    transcript_id: transcriptIdParam,
    words: { in: "query", type: "array", items: { type: "string" }, maxItems: 50, required: true, description: "Words or phrases (up to 5 words each)" },
  },
};

const deleteTranscript = {
  name: "delete_transcript",
  title: "Delete transcript",
  description: "Permanently delete a transcript's text and data (the record stays, redacted)",
  method: "DELETE",
  path: "/v2/transcript/{transcript_id}",
  write: "unsafe",
  nodeOnly: true,
  checkHint: "get_transcript and check whether the text is gone",
  params: { transcript_id: transcriptIdParam },
};

const llmGatewayBaseUrl = (environment) => resolveRegionalBaseUrl(environment, "llm-gateway");

const createChatCompletion = {
  name: "create_chat_completion",
  title: "LLM Gateway chat",
  description: "Ask an LLM through AssemblyAI's LLM Gateway (successor of LeMUR), e.g. to summarize a transcript's text (billed per token)",
  method: "POST",
  baseUrl: llmGatewayBaseUrl,
  path: "/v1/chat/completions",
  // Billed per token: never retried after a timeout or 5xx.
  write: "unsafe",
  checkHint: "the usage page of the AssemblyAI dashboard",
  timeoutMs: 170000,
  params: {
    model: { in: "body", type: "string", required: true, description: "Model id from list_llm_models" },
    messages: { in: "body", type: "array", items: { type: "object" }, maxItems: 100, description: 'Chat messages: [{"role": "user", "content": "..."}]' },
    prompt: { in: "body", type: "string", description: "A single prompt, instead of messages" },
    max_tokens: { in: "body", type: "integer", min: 1, description: "Maximum output tokens (default 1000)" },
    temperature: { in: "body", type: "number", min: 0, max: 2, description: "Sampling temperature" },
  },
};

// The docs mark this endpoint `security: []` ("doesn't require authentication"), so the key is not sent.
const listLlmModels = {
  name: "list_llm_models",
  title: "List LLM Gateway models",
  description: "List the models available through the LLM Gateway",
  baseUrl: llmGatewayBaseUrl,
  sendCredential: false,
  path: "/v1/models",
};

const restDefinition = defineRestPlugin({
  name: "assemblyai",
  version: "0.1.0",
  description: "AssemblyAI: upload audio, transcribe with speakers, PII redaction and audio intelligence, subtitles and word search, and LLM Gateway prompts",
  apiName: "AssemblyAI API",
  baseUrl: (environment) => resolveRegionalBaseUrl(environment, "api"),
  allowedHostSuffix: ".assemblyai.com",
  auth: { type: "header", header: "Authorization", env: "ASSEMBLYAI_API_KEY" },
  extraEnv: [REGION_ENV],
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  // {"error": "message"}; the LLM Gateway uses {"code", "message"}.
  errors: { messagePath: ["error", "message"] },
  apiRequest: { examplePath: "/v2/transcript" },
  operations: [uploadFile, transcribe, getTranscript, listTranscripts, getSentences, getParagraphs, getSubtitles, searchWords, deleteTranscript, createChatCompletion, listLlmModels],
});

export const pluginDefinition = restDefinition;
