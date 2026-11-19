/**
 * openai-audio plugin definition: text to speech, transcription and translation through the OpenAI Audio API
 * (https://platform.openai.com/docs/api-reference/audio). Built with the declarative REST layer
 * (docs/declarative-plugins.md). Speech is written to $OPENAI_AUDIO_OUTPUT_DIR; local input files must be inside
 * $OPENAI_AUDIO_UPLOAD_DIR. Every billed call is `write: "unsafe"`: never retried after a timeout or 5xx, because
 * OpenAI may already have processed and billed it.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const OUTPUT_DIR_ENV = "OPENAI_AUDIO_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "OPENAI_AUDIO_UPLOAD_DIR";
// OpenAI's own limit for transcription and translation uploads.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const TRANSCRIPT_FORMATS = ["json", "text", "srt", "verbose_json", "vtt", "diarized_json"];
const uploadSettings = { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES };
const PAID_CALL = { write: "unsafe", checkHint: "the project's usage page (platform.openai.com/usage) to see whether it was billed" };

const audioFileParam = {
  in: "body",
  type: "string",
  file: true,
  required: true,
  description: "Audio file up to 25 MB (flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm)",
};
const promptParam = { in: "body", type: "string", description: "Text to guide style or vocabulary (same language as the audio; English for translations)" };
const temperatureParam = { in: "body", type: "number", min: 0, max: 1, description: "Sampling temperature (default 0)" };

const createSpeech = {
  name: "create_speech",
  title: "Text to speech",
  description: "Turn text (up to 4096 characters) into speech and save the audio file in OPENAI_AUDIO_OUTPUT_DIR (billed per character or token)",
  method: "POST",
  path: "/audio/speech",
  ...PAID_CALL,
  timeoutMs: 110000,
  params: {
    input: { in: "body", type: "string", required: true, minLength: 1, description: "Text to speak (max 4096 characters)" },
    model: { in: "body", type: "string", default: "gpt-4o-mini-tts", description: "gpt-4o-mini-tts, tts-1 or tts-1-hd" },
    voice: {
      in: "body",
      type: "string",
      default: "alloy",
      description: "alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin or cedar (or a custom voice id)",
    },
    instructions: { in: "body", type: "string", description: "Tone, accent or style instructions (gpt-4o-mini-tts only)" },
    response_format: { in: "body", type: "string", enum: ["mp3", "opus", "aac", "flac", "wav", "pcm"], description: "Audio format (default mp3)" },
    speed: { in: "body", type: "number", min: 0.25, max: 4, description: "Speed (default 1.0)" },
  },
  // Plain audio bytes, never server-sent events.
  constants: { headers: { accept: "application/octet-stream" } },
  response: { binary: { envDir: OUTPUT_DIR_ENV, maxBytes: 100 * 1024 * 1024 } },
};

const createTranscription = {
  name: "create_transcription",
  title: "Transcribe audio",
  description: "Transcribe audio to text in its own language (https URL or a file inside OPENAI_AUDIO_UPLOAD_DIR; billed per minute of audio)",
  method: "POST",
  path: "/audio/transcriptions",
  ...PAID_CALL,
  bodyMode: "multipart",
  multipart: uploadSettings,
  timeoutMs: 170000,
  params: {
    file: audioFileParam,
    model: { in: "body", type: "string", default: "gpt-4o-mini-transcribe", description: "gpt-4o-mini-transcribe, gpt-4o-transcribe, gpt-4o-transcribe-diarize, gpt-transcribe or whisper-1" },
    language: { in: "body", type: "string", description: "ISO-639-1 language of the audio, e.g. id; improves accuracy and latency" },
    prompt: promptParam,
    response_format: {
      in: "body",
      type: "string",
      enum: TRANSCRIPT_FORMATS,
      description: "json (default); gpt-4o(-mini)-transcribe support json only; srt, vtt and verbose_json are whisper-1; diarized_json is gpt-4o-transcribe-diarize",
    },
    temperature: temperatureParam,
    timestamp_granularities: {
      in: "body",
      type: "array",
      items: { type: "string", enum: ["word", "segment"] },
      maxItems: 2,
      wireName: '["timestamp_granularities[]"]',
      description: "word and/or segment timestamps (whisper-1 with verbose_json)",
    },
    include: {
      in: "body",
      type: "array",
      items: { type: "string", enum: ["logprobs"] },
      maxItems: 1,
      wireName: '["include[]"]',
      description: "Extra output: logprobs (gpt-4o(-mini)-transcribe with json)",
    },
    chunking_strategy: { in: "body", type: "string", enum: ["auto"], description: "auto: split the audio on silence first (required by the diarize model for audio over 30 s)" },
  },
};

const createTranslation = {
  name: "create_translation",
  title: "Translate audio to English",
  description: "Transcribe audio in any supported language into English text (https URL or a file inside OPENAI_AUDIO_UPLOAD_DIR; whisper-1, billed per minute)",
  method: "POST",
  path: "/audio/translations",
  ...PAID_CALL,
  bodyMode: "multipart",
  multipart: uploadSettings,
  timeoutMs: 170000,
  params: {
    file: audioFileParam,
    model: { in: "body", type: "string", default: "whisper-1", description: "whisper-1 (the only translation model)" },
    prompt: promptParam,
    response_format: { in: "body", type: "string", enum: ["json", "text", "srt", "verbose_json", "vtt"], description: "Output format (default json)" },
    temperature: temperatureParam,
  },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List the models the key can use (look for tts-*, *-transcribe and whisper-1)",
  path: "/models",
  response: { dataPath: "data" },
};

export const pluginDefinition = defineRestPlugin({
  name: "openai-audio",
  version: "0.1.0",
  description: "OpenAI audio: text to speech saved as audio files, transcription and translation to English from files or URLs",
  apiName: "OpenAI API",
  baseUrl: "https://api.openai.com/v1",
  auth: { type: "bearer", env: "OPENAI_API_KEY" },
  // Requests take up to 170 s; the rest is for downloading https audio inputs first.
  limits: { timeout_ms: 300000 },
  // {"error": {"message", "type", "param", "code"}}
  errors: {
    messagePath: "error.message",
    codePath: "error.code",
    kindByCode: { invalid_api_key: "auth_error", insufficient_quota: "rate_limited", rate_limit_exceeded: "rate_limited", model_not_found: "not_found" },
  },
  apiRequest: { examplePath: "/models" },
  operations: [createSpeech, createTranscription, createTranslation, listModels],
});
