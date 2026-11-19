/**
 * Parameter schemas shared by the ffmpeg operations, and the input helper they all use.
 */
import { MEDIA_INPUT_EXTENSIONS, QUALITY_LEVELS, VIDEO_CODEC_NAMES, AUDIO_CODEC_NAMES } from "../lib/media-formats.mjs";

export { OUTPUT_NAME_PARAMETER } from "../lib/file-access.mjs";

export const INPUT_PARAMETER = {
  type: "string",
  description: "Media file path inside FFMPEG_INPUT_DIRS (or FFMPEG_OUTPUT_DIR); absolute, ~/..., or relative to the first input directory",
};
export const QUALITY_PARAMETER = { type: "string", enum: QUALITY_LEVELS, default: "medium", description: "Encoding quality preset (low = smaller file)" };
export const VIDEO_CODEC_PARAMETER = { type: "string", enum: VIDEO_CODEC_NAMES, description: "Video codec (default: the format's first codec, e.g. h264 for mp4)" };
export const AUDIO_CODEC_PARAMETER = { type: "string", enum: AUDIO_CODEC_NAMES, description: "Audio codec (default: the format's first codec, e.g. aac for mp4)" };
export const TIME_PARAMETER_DESCRIPTION = "seconds (e.g. 12.5) or HH:MM:SS[.fff]";
export const DIMENSION_SCHEMA = { type: "integer", minimum: 16, maximum: 7680 };

/**
 * Resolves the `input` argument through the allowlist, accepting only media file extensions.
 *
 * @param client - ffmpeg client (object)
 * @param rawPath - The argument (string)
 * @param parameterName - For messages (string, default "input")
 * @returns Absolute real path (string)
 */
export async function resolveMediaInput(client, rawPath, parameterName = "input") {
  const { path } = await client.fileAccess.resolveInputFile(rawPath, { parameterName, extensions: MEDIA_INPUT_EXTENSIONS });
  return path;
}
