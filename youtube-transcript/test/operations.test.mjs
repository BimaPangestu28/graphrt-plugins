/**
 * list_caption_tracks, get_transcript and parse_captions against a recording fetch (no network).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner, buildManifest } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { clearCachedAccessTokens } from "../lib/oauth.mjs";
import { pluginDefinition } from "../definition.mjs";

const ENVIRONMENT = { YOUTUBE_ACCESS_TOKEN: "yt-secret-token" };
const AS_TOOL = { source: "tool" };
const VIDEO_ID = "dQw4w9WgXcQ";
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n\n00:00:01.500 --> 00:00:03.000\nworld\n";
const TRACKS = {
  items: [
    { id: "asr-en", snippet: { videoId: VIDEO_ID, language: "en", name: "", trackKind: "asr", isAutoSynced: false, isCC: false, isDraft: false, status: "serving", lastUpdated: "2026-11-01T00:00:00Z" } },
    { id: "std-en", snippet: { videoId: VIDEO_ID, language: "en", name: "English", trackKind: "standard", isAutoSynced: false, isCC: true, isDraft: false, status: "serving", lastUpdated: "2026-11-02T00:00:00Z" } },
    { id: "std-de", snippet: { videoId: VIDEO_ID, language: "de", name: "Deutsch", trackKind: "standard", isDraft: false, status: "serving" } },
    { id: "draft-fr", snippet: { videoId: VIDEO_ID, language: "fr", name: "Brouillon", trackKind: "standard", isDraft: true, status: "serving" } },
  ],
};

function createRunner(responses, environment = ENVIRONMENT) {
  const fetchImpl = createRecordingFetch(responses);
  return { runOperation: createOperationRunner(pluginDefinition, environment, { fetchImpl }), fetchImpl };
}

beforeEach(() => clearCachedAccessTokens());

test("list_caption_tracks: captions.list with OAuth, normalised tracks", async () => {
  const { runOperation, fetchImpl } = createRunner([{ body: TRACKS }]);
  const { data } = await runOperation("list_caption_tracks", { video: `https://youtu.be/${VIDEO_ID}` }, AS_TOOL);
  const call = fetchImpl.calls[0];
  assert.equal(call.path, "/youtube/v3/captions");
  assert.deepEqual(call.query, { part: "snippet", videoId: VIDEO_ID });
  assert.equal(call.headers.authorization, "Bearer yt-secret-token");
  assert.equal(data.video_id, VIDEO_ID);
  assert.deepEqual(data.tracks[1], { id: "std-en", language: "en", name: "English", track_kind: "standard", is_cc: true, is_auto_synced: false, is_draft: false, status: "serving", last_updated: "2026-11-02T00:00:00Z" });
});

test("get_transcript: picks the standard track in the language, downloads WebVTT and parses it", async () => {
  const { runOperation, fetchImpl } = createRunner([{ body: TRACKS }, { body: VTT, headers: { "content-type": "application/octet-stream" } }]);
  const { data } = await runOperation("get_transcript", { video: VIDEO_ID, language: "en" }, AS_TOOL);
  assert.equal(fetchImpl.calls[1].path, "/youtube/v3/captions/std-en");
  assert.deepEqual(fetchImpl.calls[1].query, { tfmt: "vtt" });
  assert.equal(data.track.id, "std-en");
  assert.equal(data.text, "Hello world");
  assert.equal(data.segments.length, 2);
  assert.equal(data.truncated, false);
});

test("get_transcript: falls back to auto-generated captions, skips drafts, passes translate_to as tlang", async () => {
  const onlyAsr = { items: [TRACKS.items[0], TRACKS.items[3]] };
  const { runOperation, fetchImpl } = createRunner([{ body: onlyAsr }, { body: VTT }]);
  const { data } = await runOperation("get_transcript", { video: VIDEO_ID, translate_to: "id" }, AS_TOOL);
  assert.equal(data.track.id, "asr-en");
  assert.deepEqual(fetchImpl.calls[1].query, { tfmt: "vtt", tlang: "id" });
  assert.equal(data.translated_to, "id");
});

test("get_transcript: caption_id skips the listing; format srt returns the raw file", async () => {
  const srt = "1\n00:00:00,000 --> 00:00:01,000\nHi\n";
  const { runOperation, fetchImpl } = createRunner([{ body: srt }]);
  const { data } = await runOperation("get_transcript", { video: VIDEO_ID, caption_id: "std-en", format: "srt" }, AS_TOOL);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(fetchImpl.calls[0].query, { tfmt: "srt" });
  assert.equal(data.caption_file, srt);
  assert.equal(data.segments, undefined);
});

test("get_transcript: no track in the language is not_found and names the languages there are", async () => {
  const { runOperation } = createRunner([{ body: TRACKS }]);
  await assert.rejects(runOperation("get_transcript", { video: VIDEO_ID, language: "ja" }, AS_TOOL), { kind: "not_found", message: /de, en/ });
});

test("get_transcript: max_chars caps the text and sets truncated", async () => {
  const { runOperation } = createRunner([{ body: TRACKS }, { body: VTT }]);
  const { data } = await runOperation("get_transcript", { video: VIDEO_ID, language: "en", max_chars: 100 }, AS_TOOL);
  assert.equal(data.truncated, false);
  const long = `WEBVTT\n\n${Array.from({ length: 50 }, (unused, index) => `00:00:${String(index).padStart(2, "0")}.000 --> 00:00:${String(index).padStart(2, "0")}.900\nword${index} and more words`).join("\n\n")}\n`;
  const second = createRunner([{ body: TRACKS }, { body: long }]);
  const capped = await second.runOperation("get_transcript", { video: VIDEO_ID, language: "en", max_chars: 100 }, AS_TOOL);
  assert.equal(capped.data.truncated, true);
  assert.ok(capped.data.text.length <= 101);
});

test("a 403 on download (not the video's editor) is permission_denied with the reason", async () => {
  const forbidden = { status: 403, body: { error: { code: 403, message: "The permissions associated with the request are not sufficient to download the caption track.", errors: [{ reason: "forbidden" }] } } };
  const { runOperation } = createRunner([forbidden]);
  await assert.rejects(runOperation("get_transcript", { video: VIDEO_ID, caption_id: "std-en" }, AS_TOOL), (error) => {
    assert.equal(error.kind, "permission_denied");
    assert.match(error.message, /edit/);
    assert.doesNotMatch(error.message, /yt-secret-token/);
    return true;
  });
});

test("no credentials: auth_error naming the variables", async () => {
  const { runOperation } = createRunner([], {});
  await assert.rejects(runOperation("list_caption_tracks", { video: VIDEO_ID }, AS_TOOL), { kind: "auth_error", message: /YOUTUBE_ACCESS_TOKEN/ });
});

test("parse_captions: needs no credentials or network", async () => {
  const { runOperation, fetchImpl } = createRunner([], {});
  const { data } = await runOperation("parse_captions", { content: VTT }, AS_TOOL);
  assert.equal(data.text, "Hello world");
  assert.equal(fetchImpl.calls.length, 0);
});

test("manifest: all operations are read-only tools", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["list_caption_tracks", "get_transcript", "parse_captions"]);
  assert.equal(manifest.permissions.network, true);
});
