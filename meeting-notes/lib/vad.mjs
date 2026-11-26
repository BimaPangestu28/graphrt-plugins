/**
 * WAV decoding and a simple energy-based voice activity detector.
 *
 * whisper invents text for silence, and a meeting's mic track is mostly silent while the others talk. Each track is
 * cut into 30 ms frames; a frame is voiced when its RMS level is FLOOR_FACTOR times the track's noise floor (its
 * quietest tenth) and above ABSOLUTE_MIN_RMS. A track with less than MIN_SPEECH_MS of speech is not transcribed, and
 * whisper segments that do not overlap voiced audio are dropped.
 */
import { pluginError } from "./errors.mjs";

const FRAME_MS = 30;
const ABSOLUTE_MIN_RMS = 300;
const FLOOR_FACTOR = 3;
const MERGE_GAP_MS = 300;
export const MIN_SPEECH_MS = 1000;

/**
 * Decodes a 16-bit PCM WAV (mono, or the first channel). A data chunk whose size was never written (recorder killed)
 * is read to the end of the file.
 *
 * @param bytes - File contents (Buffer)
 * @returns `{sampleRate, samples}` with samples as Int16Array (object)
 * @throws PluginError kind `invalid_input` - When it is not 16-bit PCM WAV
 */
export function parseWav(bytes) {
  const invalid = (reason) => pluginError("invalid_input", `Audio file: ${reason}`);
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw invalid("not a WAV file");
  let position = 12;
  let format = null;
  while (position + 8 <= bytes.length) {
    const id = bytes.toString("ascii", position, position + 4);
    const declared = bytes.readUInt32LE(position + 4);
    const bodyStart = position + 8;
    const bodyEnd = id === "data" && (declared === 0 || bodyStart + declared > bytes.length) ? bytes.length : Math.min(bodyStart + declared, bytes.length);
    if (id === "fmt ") {
      if (bodyEnd - bodyStart < 16) throw invalid("short format chunk");
      format = { audioFormat: bytes.readUInt16LE(bodyStart), channels: bytes.readUInt16LE(bodyStart + 2), sampleRate: bytes.readUInt32LE(bodyStart + 4), bits: bytes.readUInt16LE(bodyStart + 14) };
    } else if (id === "data") {
      if (!format) throw invalid("data before format");
      if (format.audioFormat !== 1 || format.bits !== 16 || format.channels === 0) throw invalid("only 16-bit PCM is supported");
      const frameBytes = 2 * format.channels;
      const count = Math.floor((bodyEnd - bodyStart) / frameBytes);
      const samples = new Int16Array(count);
      for (let index = 0; index < count; index += 1) samples[index] = bytes.readInt16LE(bodyStart + index * frameBytes);
      return { sampleRate: format.sampleRate, samples };
    }
    position = bodyEnd + ((bodyEnd - bodyStart) % 2);
  }
  throw invalid("no audio data");
}

function frameLevels({ sampleRate, samples }) {
  const frameSamples = Math.max(1, Math.floor((sampleRate * FRAME_MS) / 1000));
  const levels = [];
  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(start + frameSamples, samples.length);
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
    levels.push(Math.sqrt(sum / (end - start)));
  }
  return levels;
}

/**
 * The voiced stretches of decoded audio.
 *
 * @param pcm - `{sampleRate, samples}` (object)
 * @returns `[{start_ms, end_ms}]` (Array<object>)
 */
export function voicedRanges(pcm) {
  const levels = frameLevels(pcm);
  if (levels.length === 0) return [];
  const sorted = [...levels].sort((left, right) => left - right);
  const threshold = Math.max(sorted[Math.floor(sorted.length / 10)] * FLOOR_FACTOR, ABSOLUTE_MIN_RMS);
  const ranges = [];
  levels.forEach((level, index) => {
    if (level < threshold) return;
    const startMs = index * FRAME_MS;
    const last = ranges.at(-1);
    if (last && startMs <= last.end_ms + MERGE_GAP_MS) last.end_ms = startMs + FRAME_MS;
    else ranges.push({ start_ms: startMs, end_ms: startMs + FRAME_MS });
  });
  return ranges;
}

/** Total voiced time of ranges (ms). */
export const speechMs = (ranges) => ranges.reduce((total, range) => total + range.end_ms - range.start_ms, 0);

/**
 * Keeps the segments that overlap voiced audio, with `slackMs` on each side (whisper's timestamps are coarse).
 *
 * @param segments - `[{start_ms, end_ms, text}]` (Array<object>)
 * @param ranges - Voiced ranges (Array<object>)
 * @param slackMs - Tolerance (number)
 * @returns The kept segments (Array<object>)
 */
export function keepVoicedSegments(segments, ranges, slackMs) {
  return segments.filter((segment) => {
    const start = Math.max(0, segment.start_ms - slackMs);
    const end = Math.max(segment.end_ms, segment.start_ms) + slackMs;
    return ranges.some((range) => range.start_ms < end && start < range.end_ms);
  });
}
