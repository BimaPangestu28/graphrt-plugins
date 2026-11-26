import { test } from "node:test";
import assert from "node:assert/strict";
import { keepVoicedSegments, parseWav, speechMs, voicedRanges } from "../lib/vad.mjs";
import { mergeTracks, parseWhisperJson, renderTranscript } from "../lib/transcript.mjs";
import { wav } from "./helpers.mjs";

test("decodes 16-bit WAV, also one whose data size was never written", () => {
  assert.equal(parseWav(wav(16000, [[500, 1000]])).samples.length, 8000);
  const unfinished = wav(16000, [[100, 1000]]);
  unfinished.writeUInt32LE(0, 40);
  assert.equal(parseWav(unfinished).samples.length, 1600);
  assert.throws(() => parseWav(Buffer.from("not audio")), { kind: "invalid_input" });
  const float = wav(16000, [[10, 0]]);
  float.writeUInt16LE(3, 20);
  assert.throws(() => parseWav(float), /16-bit PCM/);
});

test("finds speech between silence and none in a quiet room", () => {
  const ranges = voicedRanges(parseWav(wav(16000, [[2000, 20], [1500, 8000], [2000, 20]])));
  assert.equal(ranges.length, 1);
  assert.ok(ranges[0].start_ms >= 1950 && ranges[0].start_ms <= 2010, JSON.stringify(ranges));
  assert.ok(speechMs(ranges) >= 1400 && speechMs(ranges) <= 1560);
  assert.equal(speechMs(voicedRanges(parseWav(wav(16000, [[5000, 150]])))), 0);
  assert.equal(voicedRanges(parseWav(wav(16000, [[1000, 20], [500, 8000], [150, 20], [500, 8000], [1000, 20]]))).length, 1);
});

test("drops whisper lines over silence", () => {
  const kept = keepVoicedSegments(
    [{ start_ms: 0, end_ms: 1000, text: "invented" }, { start_ms: 1800, end_ms: 3000, text: "real" }, { start_ms: 6000, end_ms: 7000, text: "invented too" }],
    [{ start_ms: 2000, end_ms: 4000 }],
    500,
  );
  assert.deepEqual(kept.map((segment) => segment.text), ["real"]);
});

test("parses whisper JSON without silence markers", () => {
  const json = JSON.stringify({ transcription: [
    { offsets: { from: 0, to: 8000 }, text: " And so, my fellow Americans," },
    { offsets: { from: 8000, to: 9000 }, text: " [BLANK_AUDIO]" },
    { offsets: { from: 9000, to: 11000 }, text: " ask what you can do." },
  ] });
  assert.deepEqual(parseWhisperJson(json), [
    { start_ms: 0, end_ms: 8000, text: "And so, my fellow Americans," },
    { start_ms: 9000, end_ms: 11000, text: "ask what you can do." },
  ]);
  assert.throws(() => parseWhisperJson("{}"), { kind: "api_error" });
});

test("merges tracks by time and renders paragraphs per speaker", () => {
  const segment = (start, text) => ({ start_ms: start, end_ms: start + 900, text });
  const lines = mergeTracks([
    { track: "system", segments: [segment(1000, "Hi, can you hear me?"), segment(65000, "Great.")] },
    { track: "mic", segments: [segment(3000, "Yes."), segment(4000, "Let's start.")] },
  ]);
  assert.deepEqual(lines.map((line) => line.speaker), ["Others", "You", "You", "Others"]);
  assert.equal(
    renderTranscript("Zoom meeting", lines),
    "# Zoom meeting\n\n[00:00:01] Others: Hi, can you hear me?\n\n[00:00:03] You: Yes. Let's start.\n\n[00:01:05] Others: Great.\n",
  );
  assert.match(renderTranscript("Empty", []), /No speech was recognized/);
});
