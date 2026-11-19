/**
 * Video id extraction and caption parsing (WebVTT, SRT), with no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVideoId } from "../lib/video-id.mjs";
import { parseCaptionText } from "../lib/caption-parser.mjs";

test("parseVideoId: bare ids and the common URL shapes", () => {
  const expected = "dQw4w9WgXcQ";
  for (const input of [expected, `https://www.youtube.com/watch?v=${expected}&t=10`, `https://youtu.be/${expected}?si=x`, `https://m.youtube.com/shorts/${expected}`, `https://www.youtube.com/embed/${expected}`, `https://www.youtube.com/live/${expected}`, `https://www.youtube-nocookie.com/embed/${expected}`]) {
    assert.equal(parseVideoId(input), expected, input);
  }
});

test("parseVideoId: other hosts, bad ids and path tricks are invalid_input", () => {
  for (const input of ["", "short", "dQw4w9WgXcQ/../x", "https://evil.example.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=bad id here", "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"]) {
    assert.throws(() => parseVideoId(input), { kind: "invalid_input" }, input);
  }
});

const WEBVTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.500 align:start position:0%
Hello <c.colorE5E5E5>there</c>

00:00:02.500 --> 00:00:05.000
General &amp; Kenobi
second line

NOTE a comment

01:00:05.000 --> 01:00:06.250
Late
`;

test("parseCaptionText: WebVTT cues with tags removed and entities decoded", () => {
  const { segments, text } = parseCaptionText(WEBVTT);
  assert.deepEqual(segments, [
    { start_seconds: 0, end_seconds: 2.5, text: "Hello there" },
    { start_seconds: 2.5, end_seconds: 5, text: "General & Kenobi second line" },
    { start_seconds: 3605, end_seconds: 3606.25, text: "Late" },
  ]);
  assert.equal(text, "Hello there General & Kenobi second line Late");
});

test("parseCaptionText: SRT", () => {
  const { segments } = parseCaptionText("1\r\n00:00:01,000 --> 00:00:02,000\r\nOne\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,500\r\n<i>Two</i>\r\n");
  assert.deepEqual(segments, [{ start_seconds: 1, end_seconds: 2, text: "One" }, { start_seconds: 2, end_seconds: 3.5, text: "Two" }]);
});

test("parseCaptionText: rolling auto-caption duplicates are collapsed", () => {
  const rolling = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n\n00:00:01.000 --> 00:00:02.000\nhello\nworld\n\n00:00:02.000 --> 00:00:03.000\nworld\n";
  const { text } = parseCaptionText(rolling);
  assert.equal(text, "hello world");
});

test("parseCaptionText: text without cues is invalid_input", () => {
  assert.throws(() => parseCaptionText("just words"), { kind: "invalid_input" });
});
