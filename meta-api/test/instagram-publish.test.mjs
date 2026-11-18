import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses } from "./helpers.mjs";

test("publish_instagram_media IMAGE creates a container, waits, then publishes", async () => {
  const { output, calls } = await runWithResponses("publish_instagram_media", { media_type: "IMAGE", image_url: "https://img.test/a.jpg", caption: "hi" }, [
    { body: { id: "cont1" } },
    { body: { status_code: "IN_PROGRESS" } },
    { body: { status_code: "FINISHED" } },
    { body: { id: "media1" } },
  ]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["POST /v26.0/222/media", "GET /v26.0/cont1", "GET /v26.0/cont1", "POST /v26.0/222/media_publish"],
  );
  assert.equal(calls[0].form.image_url, "https://img.test/a.jpg");
  assert.equal(calls[0].form.caption, "hi");
  assert.equal(calls[0].form.media_type, undefined);
  assert.equal(calls[3].form.creation_id, "cont1");
  assert.deepEqual(output.data, { id: "media1", container_id: "cont1" });
});

test("publish_instagram_media VIDEO is published as REELS", async () => {
  const { calls } = await runWithResponses("publish_instagram_media", { media_type: "VIDEO", video_url: "https://v.test/a.mp4" }, [
    { body: { id: "c" } },
    { body: { status_code: "FINISHED" } },
    { body: { id: "m" } },
  ]);
  assert.equal(calls[0].form.media_type, "REELS");
  assert.equal(calls[0].form.video_url, "https://v.test/a.mp4");
});

test("publish_instagram_media CAROUSEL creates all children first, polls them together, then the parent", async () => {
  const { calls } = await runWithResponses(
    "publish_instagram_media",
    { media_type: "CAROUSEL", caption: "set", carousel_items: [{ image_url: "https://i.test/1.jpg" }, { video_url: "https://v.test/2.mp4" }] },
    [
      { body: { id: "child1" } },
      { body: { id: "child2" } },
      { body: { status_code: "FINISHED" } },
      { body: { status_code: "FINISHED" } },
      { body: { id: "parent" } },
      { body: { status_code: "FINISHED" } },
      { body: { id: "media" } },
    ],
  );
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    [
      "POST /v26.0/222/media",
      "POST /v26.0/222/media",
      "GET /v26.0/child1",
      "GET /v26.0/child2",
      "POST /v26.0/222/media",
      "GET /v26.0/parent",
      "POST /v26.0/222/media_publish",
    ],
  );
  assert.equal(calls[0].form.is_carousel_item, "true");
  assert.equal(calls[1].form.media_type, "VIDEO");
  assert.equal(calls[4].form.media_type, "CAROUSEL");
  assert.equal(calls[4].form.children, "child1,child2");
  assert.equal(calls[4].form.caption, "set");
  assert.equal(calls[6].form.creation_id, "parent");
});

test("publish_instagram_media reports a failed container as api_error", async () => {
  await assert.rejects(
    runWithResponses("publish_instagram_media", { media_type: "IMAGE", image_url: "https://img.test/a.jpg" }, [
      { body: { id: "c" } },
      { body: { status_code: "ERROR", status: "Error: 2207026" } },
    ]),
    (error) => error.kind === "api_error" && /2207026/.test(error.message),
  );
});

for (const [label, invalidArgs] of [
  ["IMAGE without image_url", { media_type: "IMAGE" }],
  ["REELS without video_url", { media_type: "REELS" }],
  ["STORIES without any media", { media_type: "STORIES" }],
  ["STORIES with both an image and a video", { media_type: "STORIES", image_url: "https://i.test/1.jpg", video_url: "https://v.test/2.mp4" }],
  ["CAROUSEL with one item", { media_type: "CAROUSEL", carousel_items: [{ image_url: "https://i.test/1.jpg" }] }],
  ["CAROUSEL item without media", { media_type: "CAROUSEL", carousel_items: [{}, {}] }],
]) {
  test(`publish_instagram_media rejects ${label}`, async () => {
    await assert.rejects(runWithResponses("publish_instagram_media", invalidArgs, []), (error) => error.kind === "invalid_input");
  });
}
