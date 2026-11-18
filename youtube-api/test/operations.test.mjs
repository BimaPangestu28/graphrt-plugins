import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses } from "./helpers.mjs";

const BASE_PATH = "/youtube/v3";

// Each case: operation + args → expected single request (method, path, and a subset of query; full json when given).
const REQUEST_CASES = [
  ["get_my_channel", {}, { method: "GET", path: "/channels", query: { mine: "true", part: "snippet,contentDetails,statistics" } }, { items: [{ id: "UC1" }] }],
  [
    "list_my_videos",
    { uploads_playlist_id: "UU1", limit: 10, cursor: "P2" },
    { method: "GET", path: "/playlistItems", query: { playlistId: "UU1", maxResults: "10", pageToken: "P2", part: "snippet,contentDetails" } },
  ],
  ["get_videos", { video_ids: ["v1", "v2"] }, { method: "GET", path: "/videos", query: { id: "v1,v2", part: "snippet,status,statistics,contentDetails" } }],
  ["delete_video", { video_id: "v1" }, { method: "DELETE", path: "/videos", query: { id: "v1" } }],
  [
    "list_comment_threads",
    { video_id: "v1", order: "time", search_terms: "promo", moderation_status: "heldForReview", limit: 50 },
    {
      method: "GET",
      path: "/commentThreads",
      query: { videoId: "v1", order: "time", searchTerms: "promo", moderationStatus: "heldForReview", maxResults: "50", part: "snippet,replies", textFormat: "plainText" },
    },
  ],
  ["list_comment_threads", { channel_id: "UC1", cursor: "T2" }, { method: "GET", path: "/commentThreads", query: { allThreadsRelatedToChannelId: "UC1", pageToken: "T2" } }],
  ["list_comment_replies", { parent_id: "c1", limit: 100 }, { method: "GET", path: "/comments", query: { parentId: "c1", maxResults: "100", part: "snippet" } }],
  [
    "post_comment",
    { video_id: "v1", text: "Nice!" },
    { method: "POST", path: "/commentThreads", query: { part: "snippet" }, json: { snippet: { videoId: "v1", topLevelComment: { snippet: { textOriginal: "Nice!" } } } } },
  ],
  [
    "post_comment",
    { video_id: "v1", text: "Hi", channel_id: "UC1" },
    { method: "POST", path: "/commentThreads", json: { snippet: { channelId: "UC1", videoId: "v1", topLevelComment: { snippet: { textOriginal: "Hi" } } } } },
  ],
  ["reply_to_comment", { parent_id: "c1", text: "Thanks" }, { method: "POST", path: "/comments", query: { part: "snippet" }, json: { snippet: { parentId: "c1", textOriginal: "Thanks" } } }],
  ["update_comment", { comment_id: "c2", text: "Edited" }, { method: "PUT", path: "/comments", query: { part: "snippet" }, json: { id: "c2", snippet: { textOriginal: "Edited" } } }],
  ["delete_comment", { comment_id: "c2" }, { method: "DELETE", path: "/comments", query: { id: "c2" } }],
  [
    "set_comment_moderation_status",
    { comment_ids: ["c1", "c2"], moderation_status: "rejected", ban_author: true },
    { method: "POST", path: "/comments/setModerationStatus", query: { id: "c1,c2", moderationStatus: "rejected", banAuthor: "true" } },
  ],
  ["set_comment_moderation_status", { comment_ids: ["c1"], moderation_status: "published" }, { method: "POST", path: "/comments/setModerationStatus", query: { moderationStatus: "published" } }],
  [
    "list_live_chat_messages",
    { live_chat_id: "chat1", limit: 200, cursor: "L2" },
    { method: "GET", path: "/liveChat/messages", query: { liveChatId: "chat1", maxResults: "200", pageToken: "L2", part: "id,snippet,authorDetails" } },
  ],
  [
    "send_live_chat_message",
    { live_chat_id: "chat1", text: "Hello chat" },
    {
      method: "POST",
      path: "/liveChat/messages",
      query: { part: "snippet" },
      json: { snippet: { liveChatId: "chat1", type: "textMessageEvent", textMessageDetails: { messageText: "Hello chat" } } },
    },
  ],
  ["api_request", { method: "GET", path: "/playlists", query: { mine: true, part: "snippet" } }, { method: "GET", path: "/playlists", query: { mine: "true", part: "snippet" } }],
];

for (const [operationName, args, expectedRequest, responseBody = {}] of REQUEST_CASES) {
  test(`${operationName} ${JSON.stringify(args)} sends ${expectedRequest.method} ${expectedRequest.path}`, async () => {
    const { calls } = await runWithResponses(operationName, args, [{ body: responseBody }]);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, expectedRequest.method);
    assert.equal(call.path, BASE_PATH + expectedRequest.path);
    assert.equal(call.headers.authorization, "Bearer yt-token");
    for (const [key, expectedValue] of Object.entries(expectedRequest.query ?? {})) assert.equal(call.query[key], expectedValue, `query.${key}`);
    if (expectedRequest.json) assert.deepEqual(call.json, expectedRequest.json);
  });
}

test("list operations map items and nextPageToken to data and next_cursor", async () => {
  const withNext = await runWithResponses("list_comment_replies", { parent_id: "c1" }, [{ body: { items: [{ id: "r1" }], nextPageToken: "N" } }]);
  assert.deepEqual(withNext.output, { data: [{ id: "r1" }], next_cursor: "N" });
  const lastPage = await runWithResponses("list_comment_replies", { parent_id: "c1" }, [{ body: { items: [] } }]);
  assert.deepEqual(lastPage.output, { data: [], next_cursor: null });
});

test("limit is capped at 50 for videos and 100 for comments", async () => {
  await assert.rejects(runWithResponses("list_my_videos", { uploads_playlist_id: "UU1", limit: 51 }), (error) => error.kind === "invalid_input");
  await assert.rejects(runWithResponses("list_comment_threads", { video_id: "v", limit: 101 }), (error) => error.kind === "invalid_input");
  await assert.rejects(runWithResponses("list_comment_replies", { parent_id: "c", limit: 101 }), (error) => error.kind === "invalid_input");
  await assert.rejects(runWithResponses("get_videos", { video_ids: Array.from({ length: 51 }, (_, index) => `v${index}`) }), (error) => error.kind === "invalid_input");
});

test("get_my_channel returns the channel and fails with not_found when the account has none", async () => {
  const { output } = await runWithResponses("get_my_channel", {}, [{ body: { items: [{ id: "UC1" }] } }]);
  assert.deepEqual(output.data, { id: "UC1" });
  await assert.rejects(runWithResponses("get_my_channel", {}, [{ body: { items: [] } }]), (error) => error.kind === "not_found");
});

test("list_my_videos resolves the uploads playlist from channels.list when not given", async () => {
  const { output, calls } = await runWithResponses("list_my_videos", { limit: 5 }, [
    { body: { items: [{ id: "UC1", contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] } },
    { body: { items: [{ id: "pi1" }], nextPageToken: "NEXT" } },
  ]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["GET /youtube/v3/channels", "GET /youtube/v3/playlistItems"],
  );
  assert.equal(calls[0].query.mine, "true");
  assert.equal(calls[0].query.part, "contentDetails");
  assert.equal(calls[1].query.playlistId, "UU1");
  assert.equal(calls[1].query.maxResults, "5");
  assert.deepEqual(output, { data: { uploads_playlist_id: "UU1", videos: [{ id: "pi1" }] }, next_cursor: "NEXT" });
});

test("list_my_videos fails with not_found when the channel has no uploads playlist", async () => {
  await assert.rejects(runWithResponses("list_my_videos", {}, [{ body: { items: [] } }]), (error) => error.kind === "not_found");
});

test("list_comment_threads requires exactly one of video_id or channel_id", async () => {
  await assert.rejects(runWithResponses("list_comment_threads", {}), (error) => error.kind === "invalid_input");
  await assert.rejects(runWithResponses("list_comment_threads", { video_id: "v", channel_id: "c" }), (error) => error.kind === "invalid_input");
});

test("set_comment_moderation_status allows ban_author only with rejected", async () => {
  await assert.rejects(
    runWithResponses("set_comment_moderation_status", { comment_ids: ["c1"], moderation_status: "published", ban_author: true }),
    (error) => error.kind === "invalid_input" && /ban_author/.test(error.message),
  );
});

test("delete and moderation operations report what changed on 204", async () => {
  const deleted = await runWithResponses("delete_video", { video_id: "v1" }, [{ status: 204 }]);
  assert.deepEqual(deleted.output.data, { deleted: true, video_id: "v1" });
  const moderated = await runWithResponses("set_comment_moderation_status", { comment_ids: ["c1"], moderation_status: "heldForReview" }, [{ status: 204 }]);
  assert.deepEqual(moderated.output.data, { comment_ids: ["c1"], moderation_status: "heldForReview", ban_author: false });
});

test("list_live_chat_messages returns messages with the polling interval", async () => {
  const { output } = await runWithResponses("list_live_chat_messages", { live_chat_id: "chat1" }, [
    { body: { items: [{ id: "m1" }], nextPageToken: "L3", pollingIntervalMillis: 5000 } },
  ]);
  assert.deepEqual(output, { data: { messages: [{ id: "m1" }], polling_interval_ms: 5000, offline_at: null }, next_cursor: "L3" });
});

test("live chat operations resolve the chat id from video_id", async () => {
  const { calls } = await runWithResponses("send_live_chat_message", { video_id: "live1", text: "hey" }, [
    { body: { items: [{ id: "live1", liveStreamingDetails: { activeLiveChatId: "chatX" } }] } },
    { body: { id: "msg1" } },
  ]);
  assert.equal(calls[0].path, "/youtube/v3/videos");
  assert.equal(calls[0].query.part, "liveStreamingDetails");
  assert.equal(calls[0].query.id, "live1");
  assert.equal(calls[1].json.snippet.liveChatId, "chatX");
});

test("live chat operations fail clearly when the video has no active chat or no id is given", async () => {
  await assert.rejects(
    runWithResponses("list_live_chat_messages", { video_id: "old" }, [{ body: { items: [{ id: "old", liveStreamingDetails: {} }] } }]),
    (error) => error.kind === "not_found" && /live chat/.test(error.message),
  );
  await assert.rejects(runWithResponses("list_live_chat_messages", {}), (error) => error.kind === "invalid_input");
});
