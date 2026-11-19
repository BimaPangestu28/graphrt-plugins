/**
 * The fixed menu of what ffmpeg may read and write.
 *
 * Inputs are opened only with demuxers from INPUT_DEMUXERS (no hls, dash,
 * concat scripts, image sequences or device inputs), so a crafted "video"
 * cannot make ffmpeg read other files. Outputs use the container and codec
 * presets below; tools never pass raw ffmpeg options.
 */
import { invalidInput } from "./errors.mjs";

/** Demuxers allowed for every input (`-format_whitelist`). `concat` is added only for the generated concat list. */
export const INPUT_DEMUXERS = [
  "mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "avi", "flv", "mpegts", "mpeg", "asf",
  "ogg", "wav", "mp3", "flac", "aac", "aiff", "caf", "w64", "gif",
];

/** File extensions accepted as media inputs (the content is still checked by the demuxer whitelist). */
export const MEDIA_INPUT_EXTENSIONS = [
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "flv", "ts", "mts", "m2ts", "mpg", "mpeg", "wmv", "asf", "3gp",
  "ogg", "ogv", "oga", "opus", "wav", "mp3", "flac", "aac", "m4a", "aif", "aiff", "caf", "gif",
];

const VIDEO_CODECS = {
  h264: { encoder: "libx264", crf: { low: 28, medium: 23, high: 18 }, extra: ["-pix_fmt", "yuv420p"] },
  h265: { encoder: "libx265", crf: { low: 32, medium: 28, high: 22 }, extra: ["-pix_fmt", "yuv420p", "-tag:v", "hvc1"] },
  vp9: { encoder: "libvpx-vp9", crf: { low: 40, medium: 33, high: 24 }, extra: ["-b:v", "0", "-row-mt", "1"] },
  av1: { encoder: "libsvtav1", crf: { low: 45, medium: 35, high: 26 }, extra: ["-pix_fmt", "yuv420p"] },
};

const AUDIO_CODECS = {
  aac: { encoder: "aac", bitrate: { low: "96k", medium: "128k", high: "192k" } },
  mp3: { encoder: "libmp3lame", bitrate: { low: "96k", medium: "160k", high: "256k" } },
  opus: { encoder: "libopus", bitrate: { low: "64k", medium: "96k", high: "160k" } },
  vorbis: { encoder: "libvorbis", bitrate: { low: "96k", medium: "128k", high: "192k" } },
  flac: { encoder: "flac", bitrate: null },
  pcm: { encoder: "pcm_s16le", bitrate: null },
};

/** Output container presets: extension, muxer, allowed codecs (first is the default). */
export const OUTPUT_FORMATS = {
  mp4: { extension: "mp4", muxer: "mp4", videoCodecs: ["h264", "h265"], audioCodecs: ["aac"], extra: ["-movflags", "+faststart"] },
  mov: { extension: "mov", muxer: "mov", videoCodecs: ["h264", "h265"], audioCodecs: ["aac"], extra: ["-movflags", "+faststart"] },
  mkv: { extension: "mkv", muxer: "matroska", videoCodecs: ["h264", "h265", "vp9", "av1"], audioCodecs: ["aac", "opus", "flac", "vorbis"], extra: [] },
  webm: { extension: "webm", muxer: "webm", videoCodecs: ["vp9", "av1"], audioCodecs: ["opus", "vorbis"], extra: [] },
  mp3: { extension: "mp3", muxer: "mp3", videoCodecs: [], audioCodecs: ["mp3"], extra: [] },
  m4a: { extension: "m4a", muxer: "ipod", videoCodecs: [], audioCodecs: ["aac"], extra: ["-movflags", "+faststart"] },
  wav: { extension: "wav", muxer: "wav", videoCodecs: [], audioCodecs: ["pcm"], extra: [] },
  flac: { extension: "flac", muxer: "flac", videoCodecs: [], audioCodecs: ["flac"], extra: [] },
  ogg: { extension: "ogg", muxer: "ogg", videoCodecs: [], audioCodecs: ["vorbis", "opus"], extra: [] },
  opus: { extension: "opus", muxer: "ogg", videoCodecs: [], audioCodecs: ["opus"], extra: [] },
};

export const VIDEO_FORMAT_NAMES = Object.keys(OUTPUT_FORMATS).filter((formatName) => OUTPUT_FORMATS[formatName].videoCodecs.length > 0);
export const AUDIO_FORMAT_NAMES = Object.keys(OUTPUT_FORMATS).filter((formatName) => OUTPUT_FORMATS[formatName].videoCodecs.length === 0);
export const QUALITY_LEVELS = ["low", "medium", "high"];
export const VIDEO_CODEC_NAMES = Object.keys(VIDEO_CODECS);
export const AUDIO_CODEC_NAMES = Object.keys(AUDIO_CODECS);

/**
 * Builds the encoder options for one output preset.
 *
 * @param choice - `{format, videoCodec, audioCodec, quality, includeVideo, includeAudio}` (object)
 * @returns `{extension, args}` — args are `-c:v ... -c:a ... -f <muxer>` (object)
 * @throws PluginError kind `invalid_input` - When a codec does not fit the format
 */
export function buildEncodingArguments({ format, videoCodec, audioCodec, quality = "medium", includeVideo = true, includeAudio = true }) {
  const preset = OUTPUT_FORMATS[format];
  if (!preset) throw invalidInput(`\`format\` must be one of ${Object.keys(OUTPUT_FORMATS).join(", ")}`);
  const videoArguments = includeVideo && preset.videoCodecs.length > 0 ? buildVideoArguments(preset, videoCodec, quality) : ["-vn"];
  const audioArguments = includeAudio ? buildAudioArguments(preset, audioCodec, quality) : ["-an"];
  return { extension: preset.extension, args: [...videoArguments, ...audioArguments, "-sn", "-dn", ...preset.extra, "-f", preset.muxer] };
}

function buildVideoArguments(preset, requestedCodec, quality) {
  const codecName = pickCodec(requestedCodec, preset.videoCodecs, "video_codec");
  const codec = VIDEO_CODECS[codecName];
  return ["-c:v", codec.encoder, "-crf", String(codec.crf[quality]), ...codec.extra];
}

function buildAudioArguments(preset, requestedCodec, quality) {
  const codecName = pickCodec(requestedCodec, preset.audioCodecs, "audio_codec");
  const codec = AUDIO_CODECS[codecName];
  return ["-c:a", codec.encoder, ...(codec.bitrate ? ["-b:a", codec.bitrate[quality]] : [])];
}

function pickCodec(requestedCodec, allowedCodecs, parameterName) {
  if (requestedCodec === undefined) return allowedCodecs[0];
  if (!allowedCodecs.includes(requestedCodec)) throw invalidInput(`\`${parameterName}\` for this format must be one of ${allowedCodecs.join(", ")}`);
  return requestedCodec;
}

/**
 * Picks the output format: the requested one, else the input's own container when it is a preset, else the fallback.
 *
 * @param requestedFormat - The `format` argument (string, optional)
 * @param inputPath - Input file path (string)
 * @param fallbackFormat - e.g. "mp4" (string)
 * @returns A key of OUTPUT_FORMATS (string)
 */
export function chooseOutputFormat(requestedFormat, inputPath, fallbackFormat) {
  if (requestedFormat) return requestedFormat;
  const inputExtension = inputPath.split(".").pop()?.toLowerCase();
  const matchingFormat = Object.keys(OUTPUT_FORMATS).find((formatName) => OUTPUT_FORMATS[formatName].extension === inputExtension);
  const isSameKind = matchingFormat && hasVideo(matchingFormat) === hasVideo(fallbackFormat);
  return isSameKind ? matchingFormat : fallbackFormat;
}

function hasVideo(formatName) {
  return OUTPUT_FORMATS[formatName].videoCodecs.length > 0;
}
