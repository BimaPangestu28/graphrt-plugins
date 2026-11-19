import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConcatList, buildInputArguments, buildProbeArguments, buildScaleFilter, buildSubtitlesFilter, parseTimestamp, validateExtraArguments,
} from "../lib/ffmpeg-arguments.mjs";
import { buildEncodingArguments, chooseOutputFormat } from "../lib/media-formats.mjs";
import { parseSubRip, serializeSubRip } from "../lib/subtitles.mjs";
import { resolveTrimWindow } from "../operations/encode.mjs";

test("every input is opened with the file-only protocol whitelist and the demuxer whitelist, as file:<path>", () => {
  const inputArguments = buildInputArguments("/data/in/a.mp4", { seekSeconds: 1.5 });
  assert.deepEqual(inputArguments.slice(0, 2), ["-protocol_whitelist", "file"]);
  assert.equal(inputArguments[2], "-format_whitelist");
  for (const forbiddenDemuxer of ["hls", "concat", "dash", "image2", "lavfi", "tee", "data"]) {
    assert.ok(!inputArguments[3].split(",").includes(forbiddenDemuxer), forbiddenDemuxer);
  }
  assert.deepEqual(inputArguments.slice(-4), ["-ss", "1.5", "-i", "file:/data/in/a.mp4"]);
  assert.ok(buildProbeArguments("/x/y.mov").includes("-protocol_whitelist"));
  assert.equal(buildProbeArguments("/x/y.mov").at(-1), "file:/x/y.mov");
});

test("parseTimestamp accepts seconds and clock times, refuses everything else", () => {
  const validCases = [["12.5", 12.5], [3, 3], ["01:02", 62], ["1:02:03.25", 3723.25], ["0", 0]];
  for (const [rawTime, expectedSeconds] of validCases) assert.equal(parseTimestamp(rawTime, "t"), expectedSeconds, String(rawTime));
  for (const rawTime of ["-1", "1:75", "abc", "1e3", "100000", "00:00:61", "1;rm -rf"]) {
    assert.throws(() => parseTimestamp(rawTime, "t"), { kind: "invalid_input" }, rawTime);
  }
});

test("extra_args: tools are refused; nodes get an allowlist of output options with checked values", () => {
  assert.throws(() => validateExtraArguments(["-crf", "20"], "tool"), { kind: "permission_denied" });
  assert.throws(() => validateExtraArguments(["-crf", "20"], undefined), { kind: "permission_denied" });
  assert.deepEqual(validateExtraArguments(["-crf", "20", "-preset", "slow", "-an", "-movflags", "+faststart"], "node"), ["-crf", "20", "-preset", "slow", "-an", "-movflags", "+faststart"]);
  const refusedArguments = [
    ["-i", "/etc/passwd"], ["-f", "lavfi"], ["-vf", "movie=/etc/passwd"], ["-filter_complex", "amovie=x"], ["-y"], ["-attach", "x"],
    ["-dump_attachment:t", "x"], ["-crf", "20; rm"], ["-b:v", "file:/x"], ["-preset", "../x"], ["-metadata", "title=x"], ["-protocol_whitelist", "http"],
  ];
  for (const extraArguments of refusedArguments) assert.throws(() => validateExtraArguments(extraArguments, "node"), { kind: "invalid_input" }, extraArguments.join(" "));
});

test("concat list escapes quotes and refuses control characters", () => {
  assert.equal(buildConcatList(["/a/it's.mp4", "/b/c.mp4"]), "ffconcat version 1.0\nfile '/a/it'\\''s.mp4'\nfile '/b/c.mp4'\n");
  assert.throws(() => buildConcatList(["/a/x\nfile '/etc/passwd'"]), { kind: "invalid_input" });
});

test("subtitle files are re-written from parsed cues; anything else is refused", () => {
  const cues = parseSubRip("\uFEFF1\r\n00:00:01,000 --> 00:00:02,5\r\nHello\r\nworld\r\n\r\n2\r\n00:01:00.000 --> 00:01:01.000\r\nBye\x07\r\n");
  assert.deepEqual(cues, [{ startMs: 1000, endMs: 2500, text: "Hello\nworld" }, { startMs: 60000, endMs: 61000, text: "Bye" }]);
  assert.equal(serializeSubRip(cues), "1\n00:00:01,000 --> 00:00:02,500\nHello\nworld\n\n2\n00:01:00,000 --> 00:01:01,000\nBye\n");
  assert.throws(() => parseSubRip("#EXTM3U\nfile:/etc/passwd\n"), { kind: "invalid_input" });
  assert.equal(buildSubtitlesFilter("/tmp/x/subtitles.srt", 24), "subtitles=filename=/tmp/x/subtitles.srt:force_style='FontSize=24'");
  assert.throws(() => buildSubtitlesFilter("/tmp/a'b:c/subtitles.srt"), { kind: "setup_required" });
});

test("scale filter, encoding presets and output format choice", () => {
  assert.equal(buildScaleFilter({ width: 640 }), "scale=640:-2:flags=lanczos");
  assert.equal(buildScaleFilter({ width: 640, height: 360 }), "scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos");
  assert.throws(() => buildScaleFilter({}), { kind: "invalid_input" });
  assert.deepEqual(buildEncodingArguments({ format: "webm", quality: "high" }).args, ["-c:v", "libvpx-vp9", "-crf", "24", "-b:v", "0", "-row-mt", "1", "-c:a", "libopus", "-b:a", "160k", "-sn", "-dn", "-f", "webm"]);
  assert.deepEqual(buildEncodingArguments({ format: "mp3", includeVideo: false }).args, ["-vn", "-c:a", "libmp3lame", "-b:a", "160k", "-sn", "-dn", "-f", "mp3"]);
  assert.throws(() => buildEncodingArguments({ format: "webm", videoCodec: "h264" }), { kind: "invalid_input" });
  assert.equal(chooseOutputFormat(undefined, "/a/b.MKV", "mp4"), "mkv");
  assert.equal(chooseOutputFormat(undefined, "/a/b.mp3", "mp4"), "mp4");
  assert.equal(chooseOutputFormat("webm", "/a/b.mp4", "mp4"), "webm");
});

test("trim window from start/end/duration", () => {
  assert.deepEqual(resolveTrimWindow({ start: "1", end: "00:03" }), { startSeconds: 1, durationSeconds: 2 });
  assert.deepEqual(resolveTrimWindow({ duration: "2.5" }), { startSeconds: 0, durationSeconds: 2.5 });
  assert.deepEqual(resolveTrimWindow({ start: "4" }), { startSeconds: 4, durationSeconds: undefined });
  assert.throws(() => resolveTrimWindow({ start: "5", end: "4" }), { kind: "invalid_input" });
  assert.throws(() => resolveTrimWindow({ end: "4", duration: "1" }), { kind: "invalid_input" });
});
