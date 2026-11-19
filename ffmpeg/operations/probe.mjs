/**
 * probe: ffprobe's view of one media file (container, duration, streams).
 */
import { INPUT_PARAMETER, resolveMediaInput } from "./parameters.mjs";

/**
 * Condenses ffprobe JSON into the fields workflows use.
 *
 * @param probeResult - Parsed `ffprobe -show_format -show_streams` output (object)
 * @returns `{format, duration_seconds, size_bytes, bit_rate, has_video, has_audio, streams, tags}` (object)
 */
export function summarizeProbe(probeResult) {
  const format = probeResult?.format ?? {};
  const streams = (probeResult?.streams ?? []).map(summarizeStream);
  return {
    format: format.format_name ?? null,
    format_long_name: format.format_long_name ?? null,
    duration_seconds: toNumber(format.duration),
    size_bytes: toNumber(format.size),
    bit_rate: toNumber(format.bit_rate),
    has_video: streams.some((stream) => stream.type === "video"),
    has_audio: streams.some((stream) => stream.type === "audio"),
    streams,
    tags: format.tags ?? {},
  };
}

function summarizeStream(stream) {
  const common = { index: stream.index, type: stream.codec_type, codec: stream.codec_name ?? null, codec_long_name: stream.codec_long_name ?? null, duration_seconds: toNumber(stream.duration), bit_rate: toNumber(stream.bit_rate), language: stream.tags?.language ?? null };
  if (stream.codec_type === "video") {
    return { ...common, width: stream.width, height: stream.height, pixel_format: stream.pix_fmt ?? null, frame_rate: parseFrameRate(stream.avg_frame_rate || stream.r_frame_rate), rotation: readRotation(stream) };
  }
  if (stream.codec_type === "audio") {
    return { ...common, sample_rate: toNumber(stream.sample_rate), channels: stream.channels ?? null, channel_layout: stream.channel_layout ?? null };
  }
  return common;
}

function parseFrameRate(rateText) {
  const [numerator, denominator] = String(rateText ?? "").split("/").map(Number);
  if (!Number.isFinite(numerator) || !denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function readRotation(stream) {
  const rotation = stream.side_data_list?.find((sideData) => sideData.rotation !== undefined)?.rotation ?? stream.tags?.rotate;
  return rotation === undefined ? 0 : Number(rotation);
}

function toNumber(value) {
  if (value === undefined || value === null || value === "N/A") return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

export const probeOperation = {
  name: "probe",
  title: "Probe a media file",
  description: "Reads a media file's container, duration, size, bit rate and streams (codec, resolution, frame rate, sample rate, channels, language) with ffprobe",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      include_raw: { type: "boolean", default: false, description: "Also return ffprobe's full JSON (format and streams)" },
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    const realPath = await resolveMediaInput(client, args.input);
    const probeResult = await client.probe(realPath, signal);
    return { data: { path: realPath, ...summarizeProbe(probeResult), ...(args.include_raw ? { raw: probeResult } : {}) } };
  },
};
