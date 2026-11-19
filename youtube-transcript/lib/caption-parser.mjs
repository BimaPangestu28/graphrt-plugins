/**
 * Parses WebVTT and SubRip (SRT) caption files into timed segments and one
 * plain-text transcript.
 *
 * Cue settings, styling tags (`<c>`, `<i>`, inline timestamps) and NOTE/STYLE
 * blocks are dropped and common entities decoded. Auto-generated YouTube
 * captions repeat each line in the next "rolling" cue, so the transcript
 * text skips a line that equals the line just before it.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const TIMING_PATTERN = /^\s*((?:\d{1,4}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,4}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&lrm;": "", "&rlm;": "" };

/**
 * Parses caption text.
 *
 * @param captionText - WebVTT or SRT file contents (string)
 * @returns `{segments: [{start_seconds, end_seconds, text}], text}` (object)
 * @throws PluginError kind `invalid_input` - When the text has no cues
 */
export function parseCaptionText(captionText) {
  const blocks = String(captionText ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues = blocks.map(parseBlock).filter(Boolean);
  if (cues.length === 0) throw new PluginError("No caption cues found (expected WebVTT or SRT)", { kind: "invalid_input" });
  return {
    segments: cues.map((cue) => ({ start_seconds: cue.startSeconds, end_seconds: cue.endSeconds, text: cue.lines.join(" ") })).filter((segment) => segment.text),
    text: joinWithoutRollingRepeats(cues),
  };
}

function parseBlock(block) {
  const lines = block.split("\n");
  const timingIndex = lines.findIndex((line) => TIMING_PATTERN.test(line));
  if (timingIndex === -1 || timingIndex > 1) return null;
  const [, start, end] = TIMING_PATTERN.exec(lines[timingIndex]);
  const startSeconds = toSeconds(start);
  const endSeconds = toSeconds(end);
  // A cue with impossible minutes or seconds, or one that ends before it starts, is skipped.
  if (startSeconds === null || endSeconds === null || endSeconds < startSeconds) return null;
  const textLines = lines.slice(timingIndex + 1).map(cleanCueLine).filter(Boolean);
  return { startSeconds, endSeconds, lines: textLines };
}

function cleanCueLine(line) {
  const withoutTags = line.replace(/<[^<>]*>/g, "");
  return withoutTags.replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm|#39);/g, (entity) => ENTITIES[entity]).replace(/\s+/g, " ").trim();
}

/**
 * Converts a caption timestamp to seconds.
 *
 * @param timestamp - "HH:MM:SS.mmm", "MM:SS.mmm" or with a comma (string)
 * @returns Seconds, millisecond precision, or null when minutes or seconds are 60 or more (number | null)
 *
 * @example
 * toSeconds("01:00:05,250"); // 3605.25
 */
export function toSeconds(timestamp) {
  const [clock, fraction] = timestamp.replace(",", ".").split(".");
  const parts = clock.split(":").map(Number);
  if (parts.slice(-2).some((part) => part >= 60)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Math.round((seconds + Number(`0.${fraction}`)) * 1000) / 1000;
}

function joinWithoutRollingRepeats(cues) {
  const emitted = [];
  for (const line of cues.flatMap((cue) => cue.lines)) {
    if (emitted.at(-1) !== line) emitted.push(line);
  }
  return emitted.join(" ");
}
