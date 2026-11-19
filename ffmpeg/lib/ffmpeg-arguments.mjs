/**
 * Pure builders for ffmpeg/ffprobe argument arrays.
 *
 * Every input goes through buildInputArguments: `-protocol_whitelist file`
 * (no concat:, http:, pipe:, data:, subfile: ... protocols, also inside
 * playlists) and `-format_whitelist` (no hls/dash/concat scripts), with the
 * already validated real path written as `file:<path>`. Numbers, times and
 * codec names are validated here before they reach an argument.
 */
import { invalidInput, permissionDenied, setupRequired } from "./errors.mjs";
import { INPUT_DEMUXERS } from "./media-formats.mjs";

const MAX_SECONDS = 86400;
const TIMESTAMP_PATTERN = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2}(?:\.\d{1,6})?)$/;
const BITRATE_PATTERN = /^\d{1,6}(?:\.\d{1,3})?[kKmM]?$/;
const MOVFLAGS_PATTERN = /^[+-]?[a-z_]{1,32}(?:\+[a-z_]{1,32}){0,5}$/;
const WORD_PATTERN = /^[a-z0-9_.]{1,32}$/;
const FRAME_RATE_PATTERN = /^\d{1,3}(?:\.\d{1,3})?(?:\/\d{1,4})?$/;

/** Node-only extra output options: option name → value check (null: the option takes no value). */
const EXTRA_OPTION_CHECKS = {
  "-crf": (value) => isIntegerInRange(value, 0, 63),
  "-preset": (value) => ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "good", "best", "realtime"].includes(value) || isIntegerInRange(value, 0, 13),
  "-tune": (value) => ["film", "animation", "grain", "stillimage", "fastdecode", "zerolatency", "psnr", "ssim"].includes(value),
  "-b:v": (value) => BITRATE_PATTERN.test(value),
  "-b:a": (value) => BITRATE_PATTERN.test(value),
  "-maxrate": (value) => BITRATE_PATTERN.test(value),
  "-bufsize": (value) => BITRATE_PATTERN.test(value),
  "-r": (value) => FRAME_RATE_PATTERN.test(value),
  "-g": (value) => isIntegerInRange(value, 1, 1000),
  "-ac": (value) => isIntegerInRange(value, 1, 8),
  "-ar": (value) => ["8000", "11025", "16000", "22050", "24000", "32000", "44100", "48000", "96000"].includes(value),
  "-pix_fmt": (value) => ["yuv420p", "yuv422p", "yuv444p", "yuv420p10le", "rgb24", "gray"].includes(value),
  "-profile:v": (value) => WORD_PATTERN.test(value),
  "-level": (value) => /^\d(?:\.\d)?$/.test(value),
  "-movflags": (value) => MOVFLAGS_PATTERN.test(value),
  "-q:a": (value) => isIntegerInRange(value, 0, 10),
  "-threads": (value) => isIntegerInRange(value, 0, 64),
  "-an": null,
  "-vn": null,
  "-sn": null,
};

/**
 * Builds the options that open one validated local file as an input.
 *
 * @param realPath - Absolute real path from the file allowlist (string)
 * @param options - `{seekSeconds, durationSeconds, extraDemuxers, forcedFormat, demuxerOptions}` (object, optional); only
 *   plugin code sets extraDemuxers/forcedFormat/demuxerOptions (for the generated concat list)
 * @returns Argument array ending in `-i file:<path>` (string[])
 */
export function buildInputArguments(realPath, { seekSeconds, durationSeconds, extraDemuxers = [], forcedFormat, demuxerOptions = [] } = {}) {
  return [
    "-protocol_whitelist", "file",
    "-format_whitelist", [...extraDemuxers, ...INPUT_DEMUXERS].join(","),
    ...(seekSeconds !== undefined ? ["-ss", formatSeconds(seekSeconds)] : []),
    ...(durationSeconds !== undefined ? ["-t", formatSeconds(durationSeconds)] : []),
    ...(forcedFormat ? ["-f", forcedFormat] : []),
    ...demuxerOptions,
    "-i", `file:${realPath}`,
  ];
}

/**
 * Options every ffmpeg run starts with: quiet, no stdin, no interaction.
 *
 * @returns Argument array (string[])
 */
export function buildGlobalArguments() {
  return ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error"];
}

/**
 * Builds the ffprobe arguments that print one file's format and streams as JSON.
 *
 * @param realPath - Absolute real path from the file allowlist (string)
 * @returns Argument array (string[])
 */
export function buildProbeArguments(realPath) {
  return [
    "-v", "error", "-hide_banner",
    "-protocol_whitelist", "file", "-format_whitelist", INPUT_DEMUXERS.join(","),
    "-print_format", "json", "-show_format", "-show_streams", `file:${realPath}`,
  ];
}

/**
 * Parses a time given as seconds (number or numeric string) or `[HH:]MM:SS[.fff]`.
 *
 * @param rawTime - The time argument (number | string)
 * @param parameterName - For the message (string)
 * @returns Seconds, 0 to 86400 (number)
 * @throws PluginError kind `invalid_input` - When the value is not a valid time
 *
 * @example
 * parseTimestamp("01:02.5", "start"); // 62.5
 */
export function parseTimestamp(rawTime, parameterName) {
  const text = String(rawTime).trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : parseClockTime(text);
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_SECONDS) {
    throw invalidInput(`\`${parameterName}\` must be seconds (e.g. 12.5) or HH:MM:SS[.fff], at most 24 hours`);
  }
  return seconds;
}

function parseClockTime(text) {
  const match = TIMESTAMP_PATTERN.exec(text);
  if (!match) return null;
  const [, hours = "0", minutes, seconds] = match;
  if (Number(minutes) > 59 || Number(seconds) >= 60) return null;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * Formats seconds for an ffmpeg time option.
 *
 * @param seconds - Non-negative seconds (number)
 * @returns Decimal string with at most 3 fraction digits (string)
 */
export function formatSeconds(seconds) {
  return String(Math.round(seconds * 1000) / 1000);
}

/**
 * Builds a scale filter from validated dimensions; a missing side keeps the aspect ratio.
 *
 * @param dimensions - `{width, height, keepAspect}` (object) — integers from 16 to 7680, at least one given
 * @returns Filter text such as `scale=640:-2` (string)
 * @throws PluginError kind `invalid_input` - When neither side is given
 */
export function buildScaleFilter({ width, height, keepAspect = true }) {
  if (width === undefined && height === undefined) throw invalidInput("Pass `width`, `height` or both");
  const scaledWidth = width ?? -2;
  const scaledHeight = height ?? -2;
  const fitOptions = width !== undefined && height !== undefined && keepAspect ? ":force_original_aspect_ratio=decrease:force_divisible_by=2" : "";
  return `scale=${scaledWidth}:${scaledHeight}${fitOptions}:flags=lanczos`;
}

/**
 * Checks node-supplied extra output options against the allowlist (option names and value shapes).
 *
 * @param extraArguments - e.g. ["-crf", "20", "-preset", "slow"] (string[] | undefined)
 * @param source - "node" or "tool" (string)
 * @returns The same options, ready to append before the output (string[])
 * @throws PluginError kind `permission_denied` - When a tool passes extra options
 * @throws PluginError kind `invalid_input` - When an option or value is not allowed
 */
export function validateExtraArguments(extraArguments, source) {
  if (!extraArguments || extraArguments.length === 0) return [];
  if (source !== "node") throw permissionDenied("`extra_args` is for workflow nodes only; agents choose a format, codec and quality instead");
  const validated = [];
  for (let index = 0; index < extraArguments.length; index += 1) {
    const optionName = String(extraArguments[index]);
    if (!Object.hasOwn(EXTRA_OPTION_CHECKS, optionName)) {
      throw invalidInput(`\`extra_args\`: ${JSON.stringify(optionName)} is not allowed (allowed: ${Object.keys(EXTRA_OPTION_CHECKS).join(" ")})`);
    }
    const checkValue = EXTRA_OPTION_CHECKS[optionName];
    validated.push(optionName);
    if (checkValue === null) continue;
    const optionValue = String(extraArguments[index + 1] ?? "");
    if (!checkValue(optionValue)) throw invalidInput(`\`extra_args\`: ${JSON.stringify(optionValue)} is not a valid value for ${optionName}`);
    validated.push(optionValue);
    index += 1;
  }
  return validated;
}

function isIntegerInRange(value, minimum, maximum) {
  return /^\d{1,4}$/.test(value) && Number(value) >= minimum && Number(value) <= maximum;
}

/**
 * Builds an ffconcat list for validated real paths (quotes escaped the way the concat demuxer expects).
 *
 * @param realPaths - Absolute real paths (string[])
 * @returns List file content (string)
 * @throws PluginError kind `invalid_input` - When a path contains a line break or control character
 */
export function buildConcatList(realPaths) {
  const lines = realPaths.map((realPath) => {
    if (/[\u0000-\u001f\u007f]/.test(realPath)) throw invalidInput(`Cannot concatenate ${JSON.stringify(realPath)}: the path contains control characters`);
    return `file '${realPath.replaceAll("'", "'\\''")}'`;
  });
  return `ffconcat version 1.0\n${lines.join("\n")}\n`;
}

/**
 * Builds the `subtitles` filter for a plugin-generated subtitle file.
 *
 * @param subtitlePath - Path of the sanitised copy in the plugin's temp directory (string)
 * @param fontSize - Optional font size, integer 8 to 120 (number, optional)
 * @returns Filter text (string)
 * @throws PluginError kind `setup_required` - When the temp path has characters that would need filter escaping
 */
export function buildSubtitlesFilter(subtitlePath, fontSize) {
  if (!/^[A-Za-z0-9._/-]+$/.test(subtitlePath)) {
    throw setupRequired(`The temporary directory path ${JSON.stringify(subtitlePath)} has characters ffmpeg filters cannot take safely; set TMPDIR to a plain path`);
  }
  const styleOption = fontSize !== undefined ? `:force_style='FontSize=${Math.trunc(fontSize)}'` : "";
  return `subtitles=filename=${subtitlePath}${styleOption}`;
}

/**
 * Builds the GIF filter graph: frame rate, width, and a generated palette for good colours.
 *
 * @param options - `{fps, width}` validated integers (object)
 * @returns Filter text (string)
 */
export function buildGifFilter({ fps, width }) {
  return `fps=${Math.trunc(fps)},scale=${Math.trunc(width)}:-1:flags=lanczos,split[frames][copy];[copy]palettegen=stats_mode=diff[palette];[frames][palette]paletteuse=dither=bayer`;
}
