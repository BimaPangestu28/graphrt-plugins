/**
 * Review fixes: caption size cap, linear tag stripping, segments bounded by max_chars, timestamp range checks,
 * error hints only where they apply, and caption_id calls that do not claim a video.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearCachedAccessTokens } from "../lib/oauth.mjs";
import { pluginDefinition } from "../definition.mjs";
import { parseCaptionText } from "../lib/caption-parser.mjs";

const AS_TOOL = { source: "tool" };
const ENVIRONMENT = { YOUTUBE_ACCESS_TOKEN: "yt-secret-token" };

function createRunner(responses, environment = ENVIRONMENT) {
  const fetchImpl = createRecordingFetch(responses);
  return { runOperation: createOperationRunner(pluginDefinition, environment, { fetchImpl }), fetchImpl };
}

beforeEach(() => clearCachedAccessTokens());

test("parse_captions: content over YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES is refused", async () => {
  const { runOperation } = createRunner([], { YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES: "65536" });
  const big = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${"x".repeat(70000)}\n`;
  await assert.rejects(runOperation("parse_captions", { content: big }, AS_TOOL), { kind: "invalid_input", message: /65536/ });
});

test("tag stripping is linear on unclosed tags", () => {
  const cue = `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${"<c".repeat(100000)}x\n`;
  const started = performance.now();
  parseCaptionText(cue);
  assert.ok(performance.now() - started < 500);
});

test("max_chars bounds segments even when the deduplicated text is short", async () => {
  const repeated = `WEBVTT\n\n${Array.from({ length: 10 }, (unused, index) => `00:00:0${index}.000 --> 00:00:0${index}.900\n${"x".repeat(100)}`).join("\n\n")}\n`;
  const { runOperation } = createRunner([]);
  const { data } = await runOperation("parse_captions", { content: repeated, max_chars: 300 }, AS_TOOL);
  assert.equal(data.text.length, 100);
  assert.ok(data.segments.reduce((total, segment) => total + segment.text.length, 0) <= 300);
  assert.equal(data.truncated, true);
});

test("max_chars bounds the segments as well as the text (rolling captions repeat lines)", async () => {
  const rolling = `WEBVTT\n\n${Array.from({ length: 200 }, (unused, index) => {
    const start = `00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000`;
    return `${start} --> ${start}\nline ${index}\nline ${index + 1}`;
  }).join("\n\n")}\n`;
  const { runOperation } = createRunner([]);
  const { data } = await runOperation("parse_captions", { content: rolling, max_chars: 500 }, AS_TOOL);
  const segmentCharacters = data.segments.reduce((total, segment) => total + segment.text.length, 0);
  assert.ok(segmentCharacters <= 500, `segments hold ${segmentCharacters} characters`);
  assert.ok(data.text.length <= 501);
  assert.equal(data.truncated, true);
});

test("timestamps out of range are skipped, and end before start is refused", () => {
  const { segments } = parseCaptionText("WEBVTT\n\n00:99:00.000 --> 01:00:00.000\nbad minutes\n\n00:00:75.000 --> 00:00:76.000\nbad seconds\n\n00:00:05.000 --> 00:00:01.000\nbackwards\n\n00:00:01.000 --> 00:00:02.000\ngood\n");
  assert.deepEqual(segments.map((segment) => segment.text), ["good"]);
});

test("a 403 forbidden on captions.list does not get the download hint; insufficientPermissions gets a scope hint", async () => {
  const forbiddenList = { status: 403, body: { error: { code: 403, message: "The request is not allowed", errors: [{ reason: "forbidden" }] } } };
  const listing = createRunner([forbiddenList]);
  await assert.rejects(listing.runOperation("list_caption_tracks", { video: "dQw4w9WgXcQ" }, AS_TOOL), (error) => {
    assert.equal(error.kind, "permission_denied");
    assert.doesNotMatch(error.message, /can edit/);
    return true;
  });
  const scope = { status: 403, body: { error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } } };
  const scoped = createRunner([scope]);
  await assert.rejects(scoped.runOperation("list_caption_tracks", { video: "dQw4w9WgXcQ" }, AS_TOOL), { kind: "permission_denied", message: /youtube\.force-ssl/ });
});

test("caption_id without video works, and the result never claims a video it did not check", async () => {
  const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n";
  const { runOperation } = createRunner([{ body: vtt }, { body: vtt }]);
  const withoutVideo = await runOperation("get_transcript", { caption_id: "abc" }, AS_TOOL);
  assert.equal(withoutVideo.data.video_id, null);
  const withVideo = await runOperation("get_transcript", { caption_id: "abc", video: "dQw4w9WgXcQ" }, AS_TOOL);
  assert.equal(withVideo.data.video_id, null);
  const { runOperation: neither } = createRunner([]);
  await assert.rejects(neither("get_transcript", {}, AS_TOOL), { kind: "invalid_input" });
});
