/**
 * Operations that combine files: concatenate (concat demuxer over a generated
 * list) and burn_subtitles (a sanitised copy of an allowlisted .srt file).
 */
import { buildEncodingArguments, chooseOutputFormat, OUTPUT_FORMATS, VIDEO_FORMAT_NAMES } from "../lib/media-formats.mjs";
import { buildConcatList, buildInputArguments, buildSubtitlesFilter } from "../lib/ffmpeg-arguments.mjs";
import { buildNameHint } from "../lib/file-access.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { parseSubRip, serializeSubRip } from "../lib/subtitles.mjs";
import { encodeSingleInput } from "./encode.mjs";
import { INPUT_PARAMETER, OUTPUT_NAME_PARAMETER, QUALITY_PARAMETER } from "./parameters.mjs";
import { openMediaInput } from "./media-input.mjs";

const MAX_CONCAT_INPUTS = 50;
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

/**
 * Describes a file's streams for the stream-copy compatibility check.
 *
 * @param summary - From summarizeProbe (object)
 * @returns e.g. "video:h264:320x240|audio:aac:44100:2" (string)
 */
export function describeStreamLayout(summary) {
  return summary.streams
    .filter((stream) => stream.type === "video" || stream.type === "audio")
    .map((stream) => (stream.type === "video" ? `video:${stream.codec}:${stream.width}x${stream.height}` : `audio:${stream.codec}:${stream.sample_rate}:${stream.channels}`))
    .join("|");
}

// Every part is probed with the strict demuxer list first, so no part can itself be a concat script or playlist.
async function probeParts(client, rawPaths, { source, signal }) {
  const parts = [];
  let totalSeconds = 0;
  for (const [index, rawPath] of rawPaths.entries()) {
    const part = await openMediaInput(client, rawPath, { parameterName: `inputs[${index}]`, source, signal });
    totalSeconds += part.summary.duration_seconds ?? 0;
    if (source !== "node" && totalSeconds > client.settings.maxToolInputSeconds) {
      throw invalidInput(`The inputs add up to more than ${client.settings.maxToolInputSeconds} s, the limit for agent calls (FFMPEG_MAX_INPUT_SECONDS)`);
    }
    parts.push(part);
  }
  return parts;
}

function assertSameLayout(parts) {
  const firstLayout = describeStreamLayout(parts[0].summary);
  const mismatch = parts.find((part) => describeStreamLayout(part.summary) !== firstLayout);
  if (mismatch) {
    throw invalidInput(`Stream copy needs identical codecs and sizes: ${mismatch.realPath} has ${describeStreamLayout(mismatch.summary)}, the first file has ${firstLayout}; pass reencode=true`);
  }
}

const concatenateOperation = {
  name: "concatenate",
  title: "Join media files",
  description: "Joins 2-50 video or audio files end to end. By default streams are copied (fast; all files must share codecs and sizes); reencode=true converts to a preset instead",
  parameters: {
    type: "object",
    properties: {
      inputs: { type: "array", items: { type: "string" }, maxItems: MAX_CONCAT_INPUTS, description: "Files in order, each inside FFMPEG_INPUT_DIRS" },
      reencode: { type: "boolean", default: false, description: "Re-encode instead of copying streams" },
      format: { type: "string", enum: Object.keys(OUTPUT_FORMATS), description: "Output format (default: the first file's container if it is a preset, else mp4)" },
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["inputs"],
  },
  run: async ({ client, args, signal, source }) => {
    if (args.inputs.length < 2) throw invalidInput("`inputs` needs at least 2 files");
    const parts = await probeParts(client, args.inputs, { source, signal });
    if (!args.reencode) assertSameLayout(parts);
    const format = chooseOutputFormat(args.format, parts[0].realPath, "mp4");
    const encodingArguments = args.reencode ? buildEncodingArguments({ format, quality: args.quality }).args : ["-c", "copy", "-sn", "-dn", "-f", OUTPUT_FORMATS[format].muxer];
    const listOptions = { extraDemuxers: ["concat"], forcedFormat: "concat", demuxerOptions: ["-safe", "0"] };
    const outputFile = await client.withScratchFile("inputs.ffconcat", buildConcatList(parts.map((part) => part.realPath)), (listPath) =>
      client.produceOutput({
        naming: { nameHint: buildNameHint(args.output_name ?? "joined"), extension: OUTPUT_FORMATS[format].extension },
        buildArguments: () => [...buildInputArguments(listPath, listOptions), ...encodingArguments],
        signal,
      }),
    );
    return { data: { ...outputFile, format, input_count: parts.length } };
  },
};

const burnSubtitlesOperation = {
  name: "burn_subtitles",
  title: "Burn in subtitles",
  description: "Renders the cues of a .srt subtitle file (inside FFMPEG_INPUT_DIRS) into the video picture and re-encodes it",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      subtitles: { type: "string", description: "SubRip (.srt) file inside FFMPEG_INPUT_DIRS" },
      font_size: { type: "integer", minimum: 8, maximum: 120, description: "Subtitle font size" },
      format: { type: "string", enum: VIDEO_FORMAT_NAMES, description: "Output format (default: the input's container if it is a preset, else mp4)" },
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input", "subtitles"],
  },
  run: async ({ client, args, signal, source }) => {
    const { realPath } = await openMediaInput(client, args.input, { source, signal });
    const subtitleFile = await client.fileAccess.readInputFile(args.subtitles, { parameterName: "subtitles", extensions: ["srt"] });
    if (subtitleFile.bytes.length > MAX_SUBTITLE_BYTES) throw invalidInput(`\`subtitles\` is over ${MAX_SUBTITLE_BYTES} bytes`);
    const cleanSubtitles = serializeSubRip(parseSubRip(subtitleFile.bytes.toString("utf8")));
    const encoding = { format: chooseOutputFormat(args.format, realPath, "mp4"), quality: args.quality };
    const outputFile = await client.withScratchFile("subtitles.srt", cleanSubtitles, (subtitlePath) =>
      encodeSingleInput(client, { realPath, args, encoding, filterArguments: ["-vf", buildSubtitlesFilter(subtitlePath, args.font_size)], signal }),
    );
    return { data: outputFile };
  },
};

export const combineOperations = [concatenateOperation, burnSubtitlesOperation];
