/**
 * Opens a media input for an operation that decodes it: allowlist, ffprobe
 * with the strict demuxer list, and the decoded-size limits.
 *
 * A small file can declare a huge picture (a 30000x30000 frame decodes to
 * gigabytes) or hours of content, so before ffmpeg decodes anything every
 * video stream's width x height must be within FFMPEG_MAX_INPUT_PIXELS, and
 * for agent tool calls the duration within FFMPEG_MAX_INPUT_SECONDS. ffmpeg
 * also gets `-max_pixels` per input as a second line (see client.mjs).
 */
import { invalidInput } from "../lib/errors.mjs";
import { summarizeProbe } from "./probe.mjs";
import { resolveMediaInput } from "./parameters.mjs";

/**
 * Checks a probe summary against the decoded-size limits.
 *
 * @param summary - From summarizeProbe (object)
 * @param limits - `{maxPixels, maxToolInputSeconds, source, label}` (object)
 * @throws PluginError kind `invalid_input` - When a stream is too large or a tool's input too long
 */
export function assertWithinMediaLimits(summary, { maxPixels, maxToolInputSeconds, source, label }) {
  for (const stream of summary.streams.filter((candidate) => candidate.type === "video")) {
    if ((stream.width ?? 0) * (stream.height ?? 0) > maxPixels) {
      throw invalidInput(`${label} has a ${stream.width}x${stream.height} video stream, over the ${maxPixels}-pixel limit (FFMPEG_MAX_INPUT_PIXELS)`);
    }
  }
  if (source !== "node" && (summary.duration_seconds ?? 0) > maxToolInputSeconds) {
    throw invalidInput(`${label} is ${summary.duration_seconds} s long, over the ${maxToolInputSeconds} s limit for agent calls (FFMPEG_MAX_INPUT_SECONDS); use a workflow node for longer media`);
  }
}

/**
 * Resolves, probes and checks one media input.
 *
 * @param client - ffmpeg client (object)
 * @param rawPath - Path argument (string)
 * @param options - `{parameterName, source, signal}` (object)
 * @returns `{realPath, summary}` (object)
 */
export async function openMediaInput(client, rawPath, { parameterName = "input", source, signal }) {
  const realPath = await resolveMediaInput(client, rawPath, parameterName);
  const summary = summarizeProbe(await client.probe(realPath, signal));
  const { maxPixels, maxToolInputSeconds } = client.settings;
  assertWithinMediaLimits(summary, { maxPixels, maxToolInputSeconds, source, label: `\`${parameterName}\`` });
  return { realPath, summary };
}
