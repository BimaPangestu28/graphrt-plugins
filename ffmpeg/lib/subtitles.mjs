/**
 * Re-writes a SubRip (.srt) file from parsed cues.
 *
 * The `subtitles` filter opens its file with ffmpeg's own format detection,
 * which the input whitelist does not cover. Parsing the cues and writing a
 * fresh .srt means the file ffmpeg opens can only be plain SubRip text.
 */
import { invalidInput } from "./errors.mjs";

const MAX_CUES = 20000;
const MAX_CUE_TEXT_LENGTH = 2000;
const TIMING_PATTERN = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/**
 * Parses SRT text into cues.
 *
 * @param subtitleText - File content (string)
 * @returns Cues `{startMs, endMs, text}` (object[])
 * @throws PluginError kind `invalid_input` - When there are no valid cues or too many
 *
 * @example
 * parseSubRip("1\n00:00:01,000 --> 00:00:02,500\nHello\n"); // [{startMs: 1000, endMs: 2500, text: "Hello"}]
 */
export function parseSubRip(subtitleText) {
  const blocks = subtitleText.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues = blocks.map(parseBlock).filter(Boolean);
  if (cues.length === 0) throw invalidInput("The subtitles file has no SubRip cues (`00:00:01,000 --> 00:00:02,000` lines)");
  if (cues.length > MAX_CUES) throw invalidInput(`The subtitles file has more than ${MAX_CUES} cues`);
  return cues;
}

function parseBlock(block) {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  const timingIndex = lines.findIndex((line) => TIMING_PATTERN.test(line.trim()));
  if (timingIndex < 0 || timingIndex > 1) return null;
  const match = TIMING_PATTERN.exec(lines[timingIndex].trim());
  const text = lines
    .slice(timingIndex + 1)
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))
    .join("\n")
    .slice(0, MAX_CUE_TEXT_LENGTH);
  if (!text) return null;
  return { startMs: toMilliseconds(match.slice(1, 5)), endMs: toMilliseconds(match.slice(5, 9)), text };
}

function toMilliseconds([hours, minutes, seconds, fraction]) {
  return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

/**
 * Writes cues as SRT text.
 *
 * @param cues - From parseSubRip (object[])
 * @returns SRT text (string)
 */
export function serializeSubRip(cues) {
  return cues.map((cue, index) => `${index + 1}\n${formatTime(cue.startMs)} --> ${formatTime(cue.endMs)}\n${cue.text}\n`).join("\n");
}

function formatTime(totalMs) {
  const pad = (value, width) => String(value).padStart(width, "0");
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor(totalMs / 60000) % 60;
  const seconds = Math.floor(totalMs / 1000) % 60;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(totalMs % 1000, 3)}`;
}
