/**
 * Re-encoding operations: transcode, extract_audio, resize and trim.
 * Every output is a new file in FFMPEG_OUTPUT_DIR built from the presets in media-formats.mjs.
 */
import { buildEncodingArguments, chooseOutputFormat, AUDIO_FORMAT_NAMES, OUTPUT_FORMATS, VIDEO_FORMAT_NAMES } from "../lib/media-formats.mjs";
import { buildInputArguments, buildScaleFilter, parseTimestamp, validateExtraArguments } from "../lib/ffmpeg-arguments.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { buildNameHint } from "../lib/file-access.mjs";
import {
  AUDIO_CODEC_PARAMETER, DIMENSION_SCHEMA, INPUT_PARAMETER, OUTPUT_NAME_PARAMETER, QUALITY_PARAMETER, TIME_PARAMETER_DESCRIPTION,
  VIDEO_CODEC_PARAMETER,
} from "./parameters.mjs";
import { openMediaInput } from "./media-input.mjs";

const ALL_FORMAT_NAMES = Object.keys(OUTPUT_FORMATS);

/**
 * Runs ffmpeg on one input into a new output with the chosen preset.
 *
 * @param client - ffmpeg client (object)
 * @param request - `{realPath, args, encoding, inputOptions, filterArguments, extraArguments, signal}` (object)
 * @returns Output description plus the format used (object)
 */
export async function encodeSingleInput(client, { realPath, args, encoding, inputOptions = {}, filterArguments = [], extraArguments = [], signal }) {
  const { extension, args: encodingArguments } = buildEncodingArguments(encoding);
  const outputFile = await client.produceOutput({
    naming: { nameHint: buildNameHint(args.output_name, realPath), extension },
    buildArguments: () => [...buildInputArguments(realPath, inputOptions), ...filterArguments, ...encodingArguments, ...extraArguments],
    signal,
  });
  return { ...outputFile, format: encoding.format };
}

const transcodeOperation = {
  name: "transcode",
  title: "Convert a media file",
  description: "Converts a video or audio file to another container/codec from a fixed preset menu (mp4, mov, mkv, webm, mp3, m4a, wav, flac, ogg, opus) at low, medium or high quality; writes a new file to FFMPEG_OUTPUT_DIR",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      format: { type: "string", enum: ALL_FORMAT_NAMES, description: "Output format" },
      video_codec: VIDEO_CODEC_PARAMETER,
      audio_codec: AUDIO_CODEC_PARAMETER,
      quality: QUALITY_PARAMETER,
      extra_args: {
        type: "array",
        items: { type: "string" },
        maxItems: 40,
        description: "Workflow nodes only: extra output options from an allowlist (-crf, -preset, -tune, -b:v, -b:a, -maxrate, -bufsize, -r, -g, -ac, -ar, -pix_fmt, -profile:v, -level, -movflags, -q:a, -threads, -an, -vn, -sn), e.g. [\"-preset\", \"slow\"]",
      },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input", "format"],
  },
  run: async ({ client, args, signal, source }) => {
    const extraArguments = validateExtraArguments(args.extra_args, source);
    const { realPath } = await openMediaInput(client, args.input, { source, signal });
    const encoding = { format: args.format, videoCodec: args.video_codec, audioCodec: args.audio_codec, quality: args.quality };
    return { data: await encodeSingleInput(client, { realPath, args, encoding, extraArguments, signal }) };
  },
};

const extractAudioOperation = {
  name: "extract_audio",
  title: "Extract the audio track",
  description: "Writes the first audio track of a video or audio file as mp3, m4a, wav, flac, ogg or opus to FFMPEG_OUTPUT_DIR",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      format: { type: "string", enum: AUDIO_FORMAT_NAMES, default: "mp3", description: "Audio format" },
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal, source }) => {
    const { realPath } = await openMediaInput(client, args.input, { source, signal });
    const encoding = { format: args.format, quality: args.quality, includeVideo: false };
    return { data: await encodeSingleInput(client, { realPath, args, encoding, filterArguments: ["-map", "0:a:0"], signal }) };
  },
};

const resizeOperation = {
  name: "resize",
  title: "Resize a video",
  description: "Scales a video to target_width and/or target_height (the missing side keeps the aspect ratio; with both, the video fits inside the box unless keep_aspect is false) and re-encodes it",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      target_width: { ...DIMENSION_SCHEMA, description: "Target width in pixels (16-7680)" },
      target_height: { ...DIMENSION_SCHEMA, description: "Target height in pixels (16-7680)" },
      keep_aspect: { type: "boolean", default: true, description: "With both sides given, fit inside the box instead of stretching" },
      format: { type: "string", enum: VIDEO_FORMAT_NAMES, description: "Output format (default: the input's container if it is one of these, else mp4)" },
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal, source }) => {
    const scaleFilter = buildScaleFilter({ width: args.target_width, height: args.target_height, keepAspect: args.keep_aspect });
    const { realPath } = await openMediaInput(client, args.input, { source, signal });
    const encoding = { format: chooseOutputFormat(args.format, realPath, "mp4"), quality: args.quality };
    return { data: await encodeSingleInput(client, { realPath, args, encoding, filterArguments: ["-vf", scaleFilter], signal }) };
  },
};

/**
 * Works out the trim window from `start` and `end` or `duration`.
 *
 * @param args - `{start, end, duration}` (object)
 * @returns `{startSeconds, durationSeconds}` — durationSeconds is undefined for "to the end" (object)
 * @throws PluginError kind `invalid_input` - When both end and duration are given, or the window is empty
 */
export function resolveTrimWindow({ start, end, duration }) {
  if (end !== undefined && duration !== undefined) throw invalidInput("Pass `end` or `duration`, not both");
  const startSeconds = start === undefined ? 0 : parseTimestamp(start, "start");
  const durationSeconds = end !== undefined ? parseTimestamp(end, "end") - startSeconds : duration !== undefined ? parseTimestamp(duration, "duration") : undefined;
  if (durationSeconds !== undefined && durationSeconds <= 0) throw invalidInput("The trim window is empty: `end` must be after `start` (or `duration` above 0)");
  return { startSeconds, durationSeconds };
}

const trimOperation = {
  name: "trim",
  title: "Cut a section",
  description: "Cuts a section of a video or audio file between `start` and `end` (or `start` plus `duration`); re-encodes for frame accuracy, or copies streams (fast, cuts at keyframes) with accurate=false",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      start: { type: "string", description: `Start time, ${TIME_PARAMETER_DESCRIPTION} (default 0)` },
      end: { type: "string", description: `End time, ${TIME_PARAMETER_DESCRIPTION}` },
      duration: { type: "string", description: `Length instead of end, ${TIME_PARAMETER_DESCRIPTION}` },
      accurate: { type: "boolean", default: true, description: "Re-encode for an exact cut (false: copy streams, faster, keyframe-aligned)" },
      format: { type: "string", enum: ALL_FORMAT_NAMES, description: "Output format (default: the input's container if it is a preset, else mp4)" },
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal, source }) => {
    const { startSeconds, durationSeconds } = resolveTrimWindow(args);
    const { realPath } = await openMediaInput(client, args.input, { source, signal });
    const format = chooseOutputFormat(args.format, realPath, "mp4");
    const inputOptions = { seekSeconds: startSeconds, durationSeconds };
    if (args.accurate) return { data: await encodeSingleInput(client, { realPath, args, encoding: { format, quality: args.quality }, inputOptions, signal }) };
    return { data: await copyStreams(client, { realPath, args, format, inputOptions, signal }) };
  },
};

async function copyStreams(client, { realPath, args, format, inputOptions, signal }) {
  const preset = OUTPUT_FORMATS[format];
  const outputFile = await client.produceOutput({
    naming: { nameHint: buildNameHint(args.output_name, realPath), extension: preset.extension },
    buildArguments: () => [...buildInputArguments(realPath, inputOptions), "-c", "copy", "-sn", "-dn", "-avoid_negative_ts", "make_zero", "-f", preset.muxer],
    signal,
  });
  return { ...outputFile, format };
}

export const encodeOperations = [transcodeOperation, extractAudioOperation, resizeOperation, trimOperation];
