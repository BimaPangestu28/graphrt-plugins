import { test } from "node:test";
import assert from "node:assert/strict";
import { openOk, runWithResponses } from "./helpers.mjs";

const CREATOR_INFO = openOk({ creator_username: "me", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] });
const describeCalls = (calls) => calls.map((call) => `${call.method} ${call.path}`);

test("publish_video direct: creator info, init, then polls until PUBLISH_COMPLETE", async () => {
  const { output, calls } = await runWithResponses(
    "publish_video",
    { video_url: "https://cdn.example.com/a.mp4", title: "hello #fyp", privacy_level: "SELF_ONLY", disable_duet: true, is_aigc: true },
    [
      CREATOR_INFO,
      openOk({ publish_id: "pub1" }),
      openOk({ status: "PROCESSING_DOWNLOAD" }),
      openOk({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [123] }),
    ],
  );
  assert.deepEqual(describeCalls(calls), [
    "POST /v2/post/publish/creator_info/query/",
    "POST /v2/post/publish/video/init/",
    "POST /v2/post/publish/status/fetch/",
    "POST /v2/post/publish/status/fetch/",
  ]);
  assert.deepEqual(calls[1].json, {
    post_info: { title: "hello #fyp", privacy_level: "SELF_ONLY", disable_duet: true, is_aigc: true },
    source_info: { source: "PULL_FROM_URL", video_url: "https://cdn.example.com/a.mp4" },
  });
  assert.deepEqual(calls[2].json, { publish_id: "pub1" });
  assert.deepEqual(output.data, { publish_id: "pub1", status: "PUBLISH_COMPLETE", fail_reason: null, post_ids: [123] });
});

test("publish_video rejects a privacy_level the creator cannot use, before init", async () => {
  await assert.rejects(
    runWithResponses("publish_video", { video_url: "https://cdn.example.com/a.mp4", privacy_level: "FOLLOWER_OF_CREATOR" }, [CREATOR_INFO]),
    (error) => error.kind === "invalid_input" && /PUBLIC_TO_EVERYONE, SELF_ONLY/.test(error.message),
  );
});

test("publish_video direct requires privacy_level", async () => {
  await assert.rejects(runWithResponses("publish_video", { video_url: "https://cdn.example.com/a.mp4" }), (error) => error.kind === "invalid_input");
});

test("publish_video inbox uses the inbox init endpoint and waits for SEND_TO_USER_INBOX", async () => {
  const { output, calls } = await runWithResponses("publish_video", { video_url: "https://cdn.example.com/a.mp4", mode: "inbox" }, [
    openOk({ publish_id: "pub2" }),
    openOk({ status: "SEND_TO_USER_INBOX" }),
  ]);
  assert.deepEqual(describeCalls(calls), ["POST /v2/post/publish/inbox/video/init/", "POST /v2/post/publish/status/fetch/"]);
  assert.deepEqual(calls[0].json, { source_info: { source: "PULL_FROM_URL", video_url: "https://cdn.example.com/a.mp4" } });
  assert.equal(output.data.status, "SEND_TO_USER_INBOX");
});

test("publish_video wait=false returns right after init", async () => {
  const { output, calls } = await runWithResponses("publish_video", { video_url: "https://cdn.example.com/a.mp4", mode: "inbox", wait: false }, [
    openOk({ publish_id: "pub3" }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(output.data, { publish_id: "pub3", status: null, fail_reason: null, post_ids: [] });
});

test("publish_video fails with the fail_reason when TikTok reports FAILED", async () => {
  await assert.rejects(
    runWithResponses("publish_video", { video_url: "https://cdn.example.com/a.mp4", mode: "inbox" }, [
      openOk({ publish_id: "pub4" }),
      openOk({ status: "FAILED", fail_reason: "file_format_check_failed" }),
    ]),
    (error) => error.kind === "api_error" && /file_format_check_failed/.test(error.message) && /pub4/.test(error.message),
  );
});

test("publish_photos direct posts photos from URLs with a cover index", async () => {
  const photoUrls = ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"];
  const { output, calls } = await runWithResponses(
    "publish_photos",
    { photo_urls: photoUrls, title: "trip", description: "day one", privacy_level: "PUBLIC_TO_EVERYONE", photo_cover_index: 1, auto_add_music: true },
    [CREATOR_INFO, openOk({ publish_id: "ph1" }), openOk({ status: "PUBLISH_COMPLETE", publicaly_available_post_id: [9] })],
  );
  assert.deepEqual(describeCalls(calls), [
    "POST /v2/post/publish/creator_info/query/",
    "POST /v2/post/publish/content/init/",
    "POST /v2/post/publish/status/fetch/",
  ]);
  assert.deepEqual(calls[1].json, {
    media_type: "PHOTO",
    post_mode: "DIRECT_POST",
    post_info: { title: "trip", description: "day one", privacy_level: "PUBLIC_TO_EVERYONE", auto_add_music: true },
    source_info: { source: "PULL_FROM_URL", photo_images: photoUrls, photo_cover_index: 1 },
  });
  assert.deepEqual(output.data.post_ids, [9]);
});

test("publish_photos upload mode sends MEDIA_UPLOAD without creator info or privacy level", async () => {
  const { calls } = await runWithResponses("publish_photos", { photo_urls: ["https://cdn.example.com/1.jpg"], mode: "upload", wait: false }, [
    openOk({ publish_id: "ph2" }),
  ]);
  assert.deepEqual(describeCalls(calls), ["POST /v2/post/publish/content/init/"]);
  assert.equal(calls[0].json.post_mode, "MEDIA_UPLOAD");
  assert.equal(calls[0].json.post_info.privacy_level, undefined);
});

test("publish_photos rejects more than 35 images, none, and an out-of-range cover index", async () => {
  const tooMany = Array.from({ length: 36 }, (_, index) => `https://cdn.example.com/${index}.jpg`);
  await assert.rejects(runWithResponses("publish_photos", { photo_urls: tooMany, mode: "upload" }), (error) => error.kind === "invalid_input");
  await assert.rejects(runWithResponses("publish_photos", { photo_urls: [], mode: "upload" }), (error) => error.kind === "invalid_input");
  await assert.rejects(
    runWithResponses("publish_photos", { photo_urls: ["https://cdn.example.com/1.jpg"], mode: "upload", photo_cover_index: 1 }),
    (error) => error.kind === "invalid_input" && /photo_cover_index/.test(error.message),
  );
});

test("refresh_access_token posts the refresh grant with env client credentials and returns the rotated tokens", async () => {
  const tokenResponse = { access_token: "act.new", refresh_token: "rft.new", expires_in: 86400, open_id: "o1", scope: "user.info.basic" };
  const { output, calls } = await runWithResponses("refresh_access_token", { refresh_token: "rft.old" }, [{ body: tokenResponse }]);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/v2/oauth/token/");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.deepEqual(calls[0].form, {
    grant_type: "refresh_token",
    refresh_token: "rft.old",
    client_key: "client-key-env",
    client_secret: "client-secret-env",
  });
  assert.deepEqual(output.data, tokenResponse);
});

test("refresh_access_token fails clearly without TIKTOK_CLIENT_SECRET", async () => {
  await assert.rejects(
    runWithResponses("refresh_access_token", { refresh_token: "rft.old" }, [{ body: {} }], { TIKTOK_CLIENT_KEY: "k" }),
    (error) => error.kind === "auth_error" && /TIKTOK_CLIENT_SECRET/.test(error.message),
  );
});

test("refresh_access_token maps an OAuth error body and redacts the refresh token", async () => {
  await assert.rejects(
    runWithResponses("refresh_access_token", { refresh_token: "rft.old" }, [
      { body: { error: "invalid_grant", error_description: "Refresh token rft.old is invalid", log_id: "L" } },
    ]),
    (error) => error.kind === "auth_error" && !error.message.includes("rft.old"),
  );
});

test("publish errors after init are never retryable and name the publish_id", async () => {
  const { withPublishId } = await import("../operations/publishing.mjs");
  const { PluginError } = await import("../lib/shared/graphrt-plugin.mjs");
  const wrapped = withPublishId(new PluginError("Still processing", { kind: "timeout", retryable: true }), "pub9");
  assert.equal(wrapped.retryable, false);
  assert.equal(wrapped.kind, "timeout");
  assert.match(wrapped.message, /publish_id pub9/);
  assert.match(wrapped.message, /get_publish_status/);
});

test("a transient 502 while polling does not abort a publish that succeeds", async () => {
  const { output } = await runWithResponses("publish_video", { video_url: "https://cdn.example.com/a.mp4", privacy_level: "SELF_ONLY" }, [
    CREATOR_INFO,
    openOk({ publish_id: "pub2" }),
    { status: 502, body: { text: "Bad gateway" } },
    openOk({ status: "PUBLISH_COMPLETE" }),
  ]);
  assert.equal(output.data.status, "PUBLISH_COMPLETE");
});

for (const [label, extraArgs] of [
  ["title", { title: "caption" }],
  ["privacy_level", { privacy_level: "SELF_ONLY" }],
  ["disable_comment", { disable_comment: true }],
]) {
  test(`publish_video mode inbox rejects ${label} instead of dropping it`, async () => {
    const { calls, error } = await runWithResponses("publish_video", { video_url: "https://cdn.example.com/a.mp4", mode: "inbox", ...extraArgs }, [])
      .then((result) => ({ ...result, error: null }), (caught) => ({ calls: [], error: caught }));
    assert.equal(error?.kind, "invalid_input");
    assert.match(error.message, new RegExp(label));
    assert.match(error.message, /TikTok app/);
    assert.equal(calls.length, 0);
  });
}

test("publish_photos accepts a single plain photo URL string", async () => {
  const { calls } = await runWithResponses("publish_photos", { photo_urls: "https://cdn.example.com/1.jpg", mode: "upload", wait: false }, [openOk({ publish_id: "p1" })]);
  assert.deepEqual(calls[0].json.source_info.photo_images, ["https://cdn.example.com/1.jpg"]);
});
