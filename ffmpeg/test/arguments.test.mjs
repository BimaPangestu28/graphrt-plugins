import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConcatList, buildInputArguments, buildProbeArguments, buildScaleFilter, buildSubtitlesFilter, escapeFilterPath, parseTimestamp, validateExtraArguments,
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
  assert.equal(buildSubtitlesFilter("/tmp/x/subtitles.srt", 24, "linux"), "subtitles=filename=/tmp/x/subtitles.srt:force_style='FontSize=24'");
});

/** Undoes one ffmpeg parsing pass the way av_get_token does: `\x` is x, `'...'` is literal; stops at an unescaped terminator. */
function readFilterToken(text, terminators) {
  let token = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      token += text[index];
    } else if (character === "'") {
      const closingQuote = text.indexOf("'", index + 1);
      token += text.slice(index + 1, closingQuote);
      index = closingQuote;
    } else if (terminators.includes(character)) {
      return { token, rest: text.slice(index) };
    } else {
      token += character;
    }
  }
  return { token, rest: "" };
}

test("subtitles filter path: escaped for both ffmpeg parsers, Windows paths written with forward slashes", () => {
  assert.equal(escapeFilterPath("C:\\Users\\me\\AppData\\Local\\Temp\\graphrt-ffmpeg-Ab12\\subtitles.srt", "win32"), "C\\\\:/Users/me/AppData/Local/Temp/graphrt-ffmpeg-Ab12/subtitles.srt");
  assert.equal(buildSubtitlesFilter("C:\\Temp\\x\\subtitles.srt", 24, "win32"), "subtitles=filename=C\\\\:/Temp/x/subtitles.srt:force_style='FontSize=24'");
  assert.equal(escapeFilterPath("\\\\server\\share\\subtitles.srt", "win32"), "//server/share/subtitles.srt");
  assert.equal(escapeFilterPath("/tmp/plain-1.2_3/subtitles.srt", "linux"), "/tmp/plain-1.2_3/subtitles.srt");
  assert.throws(() => escapeFilterPath("/tmp/a\nb/subtitles.srt", "linux"), { kind: "setup_required", message: /TMPDIR/ });
  assert.throws(() => escapeFilterPath("C:\\a\u0000b\\subtitles.srt", "win32"), { kind: "setup_required", message: /TEMP/ });

  // Whatever the temp path holds, ffmpeg's two passes give back exactly that path and nothing else: no second
  // filter (`,` `;`), no link label (`[`), no extra option (`:`), no quote left open.
  const hostilePaths = [
    ["/tmp/it's a [dir], x;y:z=1/sub\\titles.srt", "linux"],
    ["/tmp/a',drawtext=textfile=/etc/passwd,'/subtitles.srt", "linux"],
    ["/tmp/x:force_style='Fontname=/etc/passwd'/subtitles.srt", "linux"],
    ["/tmp/trailing\\/subtitles.srt", "linux"],
    ["C:\\Users\\O'Brien, J; [dev]\\Temp\\subtitles.srt", "win32"],
  ];
  for (const [hostilePath, platform] of hostilePaths) {
    const filterText = `${buildSubtitlesFilter(hostilePath, 24, platform)},format=yuv420p`;
    const graphPass = readFilterToken(filterText, [",", ";", "["]);
    assert.equal(graphPass.rest, ",format=yuv420p", hostilePath);
    const filterArguments = graphPass.token.slice("subtitles=".length);
    const optionPass = readFilterToken(filterArguments.slice("filename=".length), [":"]);
    assert.equal(optionPass.token, platform === "win32" ? hostilePath.replaceAll("\\", "/") : hostilePath);
    assert.equal(optionPass.rest, ":force_style=FontSize=24", hostilePath);
  }
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
