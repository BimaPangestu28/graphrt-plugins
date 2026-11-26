/**
 * whisper.cpp's JSON output, merging the two tracks (mic = "You", computer's sound = "Others") and the Markdown
 * transcript.
 */
import { pluginError } from "./errors.mjs";

export const SPEAKERS = { mic: "You", system: "Others" };

function isNoise(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const isBracketed = (trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("(") && trimmed.endsWith(")")) || (trimmed.startsWith("*") && trimmed.endsWith("*"));
  return isBracketed && trimmed.length < 40;
}

/**
 * Segments of whisper-cli's `-oj` output; silence markers such as `[BLANK_AUDIO]` are dropped.
 *
 * @param json - The JSON file's text (string)
 * @returns `[{start_ms, end_ms, text}]` (Array<object>)
 * @throws PluginError kind `api_error` - When it has no `transcription` list
 */
export function parseWhisperJson(json) {
  let document;
  try {
    document = JSON.parse(json);
  } catch (parseError) {
    throw pluginError("api_error", `whisper output is not JSON: ${parseError.message}`);
  }
  if (!Array.isArray(document?.transcription)) throw pluginError("api_error", "whisper output has no transcription");
  return document.transcription
    .filter((entry) => typeof entry?.text === "string" && !isNoise(entry.text))
    .map((entry) => {
      const startMs = Number.isFinite(entry.offsets?.from) ? entry.offsets.from : 0;
      const endMs = Number.isFinite(entry.offsets?.to) ? Math.max(entry.offsets.to, startMs) : startMs;
      return { start_ms: startMs, end_ms: endMs, text: entry.text.trim() };
    });
}

/**
 * Both tracks' segments as one list ordered by start time (the mic first on a tie).
 *
 * @param tracks - `[{track: "mic"|"system", segments}]` (Array<object>)
 * @returns `[{start_ms, end_ms, track, speaker, text}]` (Array<object>)
 */
export function mergeTracks(tracks) {
  const lines = tracks.flatMap(({ track, segments }) => segments.map((segment) => ({ ...segment, track, speaker: SPEAKERS[track] })));
  return lines.sort((left, right) => left.start_ms - right.start_ms || (left.track === "system") - (right.track === "system"));
}

function formatTimestamp(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

/**
 * `[00:01:05] You: text` paragraphs; consecutive segments of one speaker are joined.
 *
 * @param title - Meeting title (string)
 * @param lines - Merged lines (Array<object>)
 * @returns Markdown (string)
 */
export function renderTranscript(title, lines) {
  const paragraphs = [];
  for (const line of lines) {
    const last = paragraphs.at(-1);
    if (last && last.speaker === line.speaker) last.text += ` ${line.text}`;
    else paragraphs.push({ speaker: line.speaker, start_ms: line.start_ms, text: line.text });
  }
  const body = paragraphs.length === 0
    ? "_No speech was recognized._"
    : paragraphs.map((paragraph) => `[${formatTimestamp(paragraph.start_ms)}] ${paragraph.speaker}: ${paragraph.text}`).join("\n\n");
  return `# ${title}\n\n${body}\n`;
}
