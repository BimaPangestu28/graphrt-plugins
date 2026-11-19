/**
 * stable-audio plugin definition: music and sound generation with Stability AI's Stable Audio
 * (https://platform.stability.ai/docs/api-reference): Stable Audio 2/2.5 text-to-audio, audio-to-audio and
 * inpainting (synchronous, binary audio), Stable Audio 3.0 text-to-audio (asynchronous job), and the credit
 * balance. Built with the declarative REST layer (docs/declarative-plugins.md). Audio is written to
 * $STABLE_AUDIO_OUTPUT_DIR; local input audio must be inside $STABLE_AUDIO_UPLOAD_DIR.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const OUTPUT_DIR_ENV = "STABLE_AUDIO_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "STABLE_AUDIO_UPLOAD_DIR";
// Stability's request limit for audio inputs.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
// Generation requests take up to 280 s; audio inputs (up to 50 MB) get the remaining ~130 s to download first.
const HOST_TIMEOUT_MS = 420000;
const GENERATION_TIMEOUT_MS = 280000;

const promptParam = { in: "body", type: "string", required: true, minLength: 1, description: "What to generate: genre, instruments, mood, tempo, e.g. 'Lo-fi hip hop beat, 90 BPM, warm piano'" };
const seedParam = { in: "body", type: "integer", min: 0, max: 4294967294, description: "Seed (0 or omitted: random)" };
const outputFormatParam = { in: "body", type: "string", enum: ["mp3", "wav"], description: "Audio format (default mp3)" };
const durationParam = (maximum) => ({ in: "body", type: "number", min: 1, max: maximum, description: `Length in seconds, 1-${maximum} (default 190)` });
const stableAudio2Params = {
  model: { in: "body", type: "string", enum: ["stable-audio-2.5", "stable-audio-2"], default: "stable-audio-2.5", description: "stable-audio-2.5 (8 credits) or stable-audio-2 (about 20 credits)" },
  steps: { in: "body", type: "integer", min: 4, max: 100, description: "Sampling steps: 4-8 for stable-audio-2.5 (default 8), 30-100 for stable-audio-2 (default 50)" },
  cfg_scale: { in: "body", type: "number", min: 1, max: 25, description: "How strictly to follow the prompt (default 1 for 2.5, 7 for 2)" },
};
const audioInputParam = { in: "body", type: "string", file: true, required: true, description: "Input audio, mp3 or wav, 6-190 seconds, up to 50 MB" };
const audioResponse = { binary: { envDir: OUTPUT_DIR_ENV, maxBytes: MAX_AUDIO_BYTES } };
// Generations are paid per success and create a result; never repeat one blindly after an unknown outcome.
const generationBasics = { method: "POST", write: "unsafe", bodyMode: "multipart", timeoutMs: GENERATION_TIMEOUT_MS, checkHint: "get_balance to see whether credits were spent" };
const binaryAudioAccept = { headers: { accept: "audio/*" } };

const textToAudio = {
  ...generationBasics,
  name: "text_to_audio",
  title: "Text to audio",
  description: "Generate music or sound (up to 190 s) from a prompt with Stable Audio 2.5 or 2 and save it in STABLE_AUDIO_OUTPUT_DIR (paid in credits)",
  path: "/v2beta/audio/stable-audio-2/text-to-audio",
  params: { prompt: promptParam, duration: durationParam(190), seed: seedParam, output_format: outputFormatParam, ...stableAudio2Params },
  constants: binaryAudioAccept,
  response: audioResponse,
};

const audioToAudio = {
  ...generationBasics,
  name: "audio_to_audio",
  title: "Audio to audio",
  description: "Transform input audio (https URL or a file inside STABLE_AUDIO_UPLOAD_DIR) with a prompt and save the result in STABLE_AUDIO_OUTPUT_DIR (paid in credits)",
  path: "/v2beta/audio/stable-audio-2/audio-to-audio",
  multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
  params: {
    prompt: promptParam,
    audio: audioInputParam,
    strength: { in: "body", type: "number", min: 0, max: 1, description: "How much the input is changed: 0 keeps it, 1 ignores it (default 1)" },
    duration: durationParam(190),
    seed: seedParam,
    output_format: outputFormatParam,
    ...stableAudio2Params,
  },
  constants: binaryAudioAccept,
  response: audioResponse,
};

const inpaintAudio = {
  ...generationBasics,
  name: "inpaint_audio",
  title: "Inpaint audio",
  description: "Regenerate a time range of input audio (mask_start to mask_end) from a prompt with Stable Audio 2.5 and save the result in STABLE_AUDIO_OUTPUT_DIR (paid in credits)",
  path: "/v2beta/audio/stable-audio-2/inpaint",
  multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
  params: {
    prompt: promptParam,
    audio: audioInputParam,
    mask_start: { in: "body", type: "number", min: 0, max: 190, description: "Start of the range to regenerate, in seconds (default 30)" },
    mask_end: { in: "body", type: "number", min: 0, max: 190, description: "End of the range to regenerate, in seconds (default 190)" },
    duration: durationParam(190),
    seed: seedParam,
    steps: { in: "body", type: "integer", min: 4, max: 8, description: "Sampling steps (default 8)" },
    output_format: outputFormatParam,
  },
  constants: binaryAudioAccept,
  response: audioResponse,
};

const textToAudioV3 = {
  ...generationBasics,
  name: "text_to_audio_v3",
  title: "Text to audio (Stable Audio 3)",
  description: "Generate music or sound (up to 380 s) with Stable Audio 3.0 as a job, wait for it and save it in STABLE_AUDIO_OUTPUT_DIR (paid in credits)",
  path: "/v2beta/audio/stable-audio/text-to-audio",
  checkHint: "get_audio_result with the generation id from the error, or get_balance",
  params: {
    prompt: promptParam,
    duration: durationParam(380),
    seed: seedParam,
    steps: { in: "body", type: "integer", min: 4, max: 8, description: "Sampling steps (default 8)" },
    cfg_scale: { in: "body", type: "number", min: 1, max: 25, description: "How strictly to follow the prompt (default 1)" },
    output_format: outputFormatParam,
  },
  constants: { body: { model: "stable-audio-3" } },
  // 202 {"id"}; GET /v2beta/audio/results/{id} answers 202 {"status": "in-progress"}, then 200 {"audio", "seed", "finish_reason"}.
  job: {
    idPath: "id",
    poll: { method: "GET", path: "/v2beta/audio/results/{id}" },
    statusPath: "finish_reason",
    doneValues: ["SUCCESS"],
    // No resultPath: the finished poll body {audio, seed, finish_reason} is the result, and its base64 audio is saved.
    intervalMs: 5000,
    timeoutMs: 285000,
  },
  download: { saveTo: { base64Paths: ["audio"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_AUDIO_BYTES, maxFiles: 1 } },
};

const getAudioResult = {
  name: "get_audio_result",
  title: "Get audio result",
  description: "Fetch a Stable Audio 3 generation by id (kept 24 hours): {status: in-progress}, or the finished audio saved in STABLE_AUDIO_OUTPUT_DIR",
  path: "/v2beta/audio/results/{generation_id}",
  params: { generation_id: { in: "path", type: "string", required: true, description: "Generation id from text_to_audio_v3" } },
  download: { saveTo: { base64Paths: ["audio"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_AUDIO_BYTES, maxFiles: 1 } },
};

const getBalance = {
  name: "get_balance",
  title: "Get credit balance",
  description: "Remaining Stability AI credits (1 credit = $0.01)",
  path: "/v1/user/balance",
};

const getAccount = {
  name: "get_account",
  title: "Get account",
  description: "The account behind the key: id, email and organizations",
  path: "/v1/user/account",
};

export const pluginDefinition = defineRestPlugin({
  name: "stable-audio",
  version: "0.1.0",
  description: "Stability AI Stable Audio: music and sound effects from text, audio-to-audio and inpainting saved as audio files, plus credit balance",
  apiName: "Stability AI API",
  baseUrl: "https://api.stability.ai",
  auth: { type: "bearer", env: "STABILITY_API_KEY" },
  limits: { timeout_ms: HOST_TIMEOUT_MS },
  // v2beta: {"id", "name", "errors": ["..."]}; v1: {"id", "name", "message"}.
  errors: {
    messagePath: ["errors.0", "message"],
    codePath: "name",
    kindByCode: { unauthorized: "auth_error", rate_limit_exceeded: "rate_limited", content_moderation: "permission_denied", bad_request: "invalid_input" },
  },
  apiRequest: { examplePath: "/v1/user/balance" },
  operations: [textToAudio, audioToAudio, inpaintAudio, textToAudioV3, getAudioResult, getBalance, getAccount],
});
