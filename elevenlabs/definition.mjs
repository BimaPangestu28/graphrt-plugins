/**
 * elevenlabs plugin definition: text to speech, sound effects, speech to text, voices, models, history and
 * subscription through the ElevenLabs API (https://elevenlabs.io/docs/api-reference). Built with the declarative
 * REST layer (docs/declarative-plugins.md). Generated audio is written to $ELEVENLABS_OUTPUT_DIR. Billed calls are
 * `write: "unsafe"`: never retried after a timeout or 5xx, because ElevenLabs may already have generated and billed
 * them (TTS and sound effects also leave a history item).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { requireExactlyOne } from "./lib/require-one-of.mjs";

const OUTPUT_DIR_ENV = "ELEVENLABS_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "ELEVENLABS_UPLOAD_DIR";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000];
const OUTPUT_FORMATS = [
  "mp3_22050_32",
  "mp3_24000_48",
  ...[32, 64, 96, 128, 192].map((bitRate) => `mp3_44100_${bitRate}`),
  ...SAMPLE_RATES.map((sampleRate) => `pcm_${sampleRate}`),
  ...SAMPLE_RATES.map((sampleRate) => `wav_${sampleRate}`),
  ...[32, 64, 96, 128, 192].map((bitRate) => `opus_48000_${bitRate}`),
  "ulaw_8000",
  "alaw_8000",
];

const outputFormatParam = {
  in: "query",
  type: "string",
  enum: OUTPUT_FORMATS,
  description: "Audio format codec_samplerate_bitrate (API default mp3_44100_128; 192 kbps MP3 and 44.1 kHz PCM need Creator/Pro plans)",
};
const enableLoggingParam = {
  in: "query",
  type: "boolean",
  description: "false enables zero retention mode (enterprise only): no history item is kept",
};
const audioResponse = { binary: { envDir: OUTPUT_DIR_ENV, maxBytes: MAX_AUDIO_BYTES } };
const PAID_CALL = { write: "unsafe", checkHint: "list_history (and get_subscription's character_count) to see whether it was generated and billed" };

const textToSpeech = {
  name: "text_to_speech",
  title: "Text to speech",
  description: "Convert text to speech with a voice and save the audio file in ELEVENLABS_OUTPUT_DIR (billed per character)",
  method: "POST",
  path: "/v1/text-to-speech/{voice_id}",
  ...PAID_CALL,
  timeoutMs: 170000,
  params: {
    voice_id: { in: "path", type: "string", required: true, description: "Voice id from list_voices, e.g. JBFqnCBsd6RMkjVDRZzb" },
    text: { in: "body", type: "string", required: true, minLength: 1, description: "Text to speak" },
    model_id: { in: "body", type: "string", description: "Model id from list_models (API default eleven_multilingual_v2), e.g. eleven_flash_v2_5, eleven_v3" },
    language_code: { in: "body", type: "string", description: "ISO 639-1 language code to enforce, for models that support it" },
    voice_settings: { in: "body", type: "object", description: "Overrides the voice's settings: {stability 0-1, similarity_boost 0-1, style, use_speaker_boost, speed}" },
    seed: { in: "body", type: "integer", min: 0, max: 4294967295, description: "Seed for best-effort deterministic output" },
    previous_text: { in: "body", type: "string", description: "Text before this one, for continuity when splitting long text" },
    next_text: { in: "body", type: "string", description: "Text after this one, for continuity when splitting long text" },
    apply_text_normalization: { in: "body", type: "string", enum: ["auto", "on", "off"], description: "Spell out numbers and abbreviations (default auto)" },
    output_format: outputFormatParam,
    enable_logging: enableLoggingParam,
  },
  response: audioResponse,
};

const listVoices = {
  name: "list_voices",
  title: "List voices",
  description: "Search and list the voices available to the account (premade, cloned, generated, library), with ids, labels and preview URLs",
  path: "/v2/voices",
  params: {
    search: { in: "query", type: "string", description: "Search name, description, labels and category" },
    voice_type: { in: "query", type: "string", enum: ["personal", "community", "default", "workspace", "non-default", "non-community", "saved"], description: "Filter by voice type" },
    category: { in: "query", type: "string", enum: ["premade", "cloned", "generated", "professional"], description: "Filter by category" },
    sort: { in: "query", type: "string", enum: ["created_at_unix", "name"], description: "Sort field" },
    sort_direction: { in: "query", type: "string", enum: ["asc", "desc"], description: "Sort direction" },
    include_total_count: { in: "query", type: "boolean", description: "Include total_count (default true; false is faster)" },
  },
  response: { dataPath: "voices", cursorPath: "next_page_token", cursorParam: "next_page_token", limitParam: "page_size", hasMorePath: "has_more", maxLimit: 100 },
};

const getVoice = {
  name: "get_voice",
  title: "Get voice",
  description: "Get one voice: name, category, labels, description, preview URL, samples and settings",
  path: "/v1/voices/{voice_id}",
  params: { voice_id: { in: "path", type: "string", required: true, description: "Voice id" } },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List the models (TTS, speech to speech) with their languages, capabilities, character limits and cost factor",
  path: "/v1/models",
};

const generateSoundEffect = {
  name: "generate_sound_effect",
  title: "Generate sound effect",
  description: "Generate a sound effect from a text description and save the audio file in ELEVENLABS_OUTPUT_DIR (billed per generation)",
  method: "POST",
  path: "/v1/sound-generation",
  ...PAID_CALL,
  timeoutMs: 170000,
  params: {
    text: { in: "body", type: "string", required: true, minLength: 1, description: "Description of the sound, e.g. 'glass shattering on concrete'" },
    duration_seconds: { in: "body", type: "number", min: 0.5, max: 30, description: "Length in seconds (default: chosen from the prompt)" },
    prompt_influence: { in: "body", type: "number", min: 0, max: 1, description: "How closely to follow the prompt (default 0.3)" },
    loop: { in: "body", type: "boolean", description: "Make a seamless loop (eleven_text_to_sound_v2 only)" },
    model_id: { in: "body", type: "string", description: "Model (API default eleven_text_to_sound_v2)" },
    output_format: outputFormatParam,
  },
  response: audioResponse,
};

const speechToText = {
  name: "speech_to_text",
  title: "Speech to text",
  description: "Transcribe an audio or video file (exactly one of file: an https URL or a file inside ELEVENLABS_UPLOAD_DIR, or source_url) with word timestamps, speaker diarization and audio-event tags (billed per hour of audio)",
  method: "POST",
  path: "/v1/speech-to-text",
  ...PAID_CALL,
  bodyMode: "multipart",
  multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
  timeoutMs: 280000,
  params: {
    model_id: { in: "body", type: "string", default: "scribe_v2", description: "Transcription model, e.g. scribe_v2" },
    file: { in: "body", type: "string", file: true, description: "Audio or video file to upload (up to 100 MB here); or use source_url" },
    source_url: { in: "body", type: "string", description: "https URL of the media that ElevenLabs fetches itself (also YouTube/TikTok links); instead of file" },
    language_code: { in: "body", type: "string", description: "ISO 639-1/639-3 language code; detected when omitted" },
    tag_audio_events: { in: "body", type: "boolean", description: "Tag events like (laughter) (default true)" },
    num_speakers: { in: "body", type: "integer", min: 1, max: 32, description: "Maximum number of speakers" },
    timestamps_granularity: { in: "body", type: "string", enum: ["none", "word", "character"], description: "Timestamp detail (default word)" },
    diarize: { in: "body", type: "boolean", description: "Label which speaker is talking (default false)" },
    keyterms: { in: "body", type: "array", items: { type: "string" }, maxItems: 100, description: "Words or phrases to bias recognition towards" },
    temperature: { in: "body", type: "number", min: 0, max: 2, description: "Sampling temperature" },
    enable_logging: enableLoggingParam,
  },
};

const listHistory = {
  name: "list_history",
  title: "List history",
  description: "List generated speech items (newest first) with text, voice, model and character counts",
  path: "/v1/history",
  params: {
    voice_id: { in: "query", type: "string", description: "Only items made with this voice" },
    model_id: { in: "query", type: "string", description: "Only items made with this model" },
    search: { in: "query", type: "string", description: "Search the text" },
    source: { in: "query", type: "string", enum: ["TTS", "STS", "Flows"], description: "Only items from this source" },
    date_after_unix: { in: "query", type: "integer", description: "Only items created after this Unix time" },
    date_before_unix: { in: "query", type: "integer", description: "Only items created before this Unix time" },
    sort_direction: { in: "query", type: "string", enum: ["asc", "desc"], description: "Sort by creation time (default desc)" },
  },
  response: { dataPath: "history", cursorPath: "last_history_item_id", cursorParam: "start_after_history_item_id", limitParam: "page_size", hasMorePath: "has_more", maxLimit: 1000 },
};

const getHistoryAudio = {
  name: "get_history_audio",
  title: "Download history audio",
  description: "Download the audio of a history item into ELEVENLABS_OUTPUT_DIR (free: no new generation)",
  path: "/v1/history/{history_item_id}/audio",
  params: { history_item_id: { in: "path", type: "string", required: true, description: "History item id from list_history" } },
  response: audioResponse,
};

const getSubscription = {
  name: "get_subscription",
  title: "Get subscription",
  description: "Subscription tier, characters used and limit, reset time, voice slots and cloning access",
  path: "/v1/user/subscription",
};

const cloneVoice = {
  name: "clone_voice",
  title: "Clone voice",
  description: "Create an instant voice clone from an audio sample (https URL or a file inside ELEVENLABS_UPLOAD_DIR); you must have the speaker's consent",
  method: "POST",
  path: "/v1/voices/add",
  write: "unsafe",
  nodeOnly: true,
  checkHint: "list_voices with category cloned and look for the name",
  bodyMode: "multipart",
  multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
  timeoutMs: 170000,
  params: {
    name: { in: "body", type: "string", required: true, minLength: 1, description: "Voice name" },
    sample: { in: "body", type: "string", file: true, required: true, wireName: "files", description: "Audio sample of the speaker (1-2 minutes of clean speech works best)" },
    description: { in: "body", type: "string", description: "Voice description" },
    labels: { in: "body", type: "string", description: 'Labels as a JSON object string, e.g. {"accent":"british"}' },
    remove_background_noise: { in: "body", type: "boolean", description: "Remove background noise from the sample (default false)" },
  },
};

const deleteVoice = {
  name: "delete_voice",
  title: "Delete voice",
  description: "Delete a voice permanently",
  method: "DELETE",
  path: "/v1/voices/{voice_id}",
  write: "unsafe",
  nodeOnly: true,
  checkHint: "get_voice with the voice id (not_found means it is gone)",
  params: { voice_id: { in: "path", type: "string", required: true, description: "Voice id" } },
};

const restDefinition = defineRestPlugin({
  name: "elevenlabs",
  version: "0.1.0",
  description: "ElevenLabs: text to speech and sound effects saved as audio files, speech to text, voices, models, history and usage",
  apiName: "ElevenLabs API",
  baseUrl: "https://api.elevenlabs.io",
  auth: { type: "header", header: "xi-api-key", env: "ELEVENLABS_API_KEY" },
  // speech_to_text takes up to 280 s; https inputs (up to 100 MB) get the remaining ~160 s to download first.
  limits: { timeout_ms: 450000 },
  // {"detail": {"type", "code", "message", "status" (legacy)}}; validation errors are {"detail": [{"msg"}]}.
  errors: {
    messagePath: ["detail.message", "detail.0.msg", "detail"],
    codePath: "detail.code",
    kindByCode: {
      invalid_api_key: "auth_error",
      missing_api_key: "auth_error",
      quota_exceeded: "rate_limited",
      rate_limit_exceeded: "rate_limited",
      concurrent_limit_exceeded: "rate_limited",
      system_busy: "rate_limited",
      voice_not_found: "not_found",
    },
    retryableCodes: ["concurrent_limit_exceeded", "system_busy"],
  },
  apiRequest: { examplePath: "/v1/user/subscription" },
  operations: [
    textToSpeech,
    generateSoundEffect,
    speechToText,
    listVoices,
    getVoice,
    listModels,
    listHistory,
    getHistoryAudio,
    getSubscription,
    cloneVoice,
    deleteVoice,
  ],
});

export const pluginDefinition = requireExactlyOne(restDefinition, "speech_to_text", ["file", "source_url"]);
