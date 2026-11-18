import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses } from "./helpers.mjs";

const describeCalls = (calls) => calls.map((call) => `${call.method} ${call.path}`);
const FINISHED_FLOW = [{ body: { id: "c" } }, { body: { status: "FINISHED" } }, { body: { id: "p" } }];

test("publish_thread TEXT creates a container, polls status, then publishes", async () => {
  const { output, calls } = await runWithResponses("publish_thread", { text: "hello", reply_control: "followers_only", topic_tag: "graphrt" }, [
    { body: { id: "cont1" } },
    { body: { status: "IN_PROGRESS" } },
    { body: { status: "FINISHED" } },
    { body: { id: "post1" } },
  ]);
  assert.deepEqual(describeCalls(calls), ["POST /v1.0/me/threads", "GET /v1.0/cont1", "GET /v1.0/cont1", "POST /v1.0/me/threads_publish"]);
  assert.equal(calls[0].form.media_type, "TEXT");
  assert.equal(calls[0].form.text, "hello");
  assert.equal(calls[0].form.reply_control, "followers_only");
  assert.equal(calls[0].form.topic_tag, "graphrt");
  assert.equal(calls[1].query.fields, "status,error_message");
  assert.equal(calls[3].form.creation_id, "cont1");
  assert.deepEqual(output.data, { id: "post1", container_id: "cont1" });
});

test("publish_thread treats PUBLISHED as done", async () => {
  const { calls } = await runWithResponses("publish_thread", { text: "x" }, [{ body: { id: "c" } }, { body: { status: "PUBLISHED" } }, { body: { id: "p" } }]);
  assert.equal(calls.length, 3);
});

test("publish_thread sends reply, quote, link and poll fields", async () => {
  const { calls } = await runWithResponses(
    "publish_thread",
    { text: "poll?", reply_to_id: "r1", quote_post_id: "q1", link_attachment: "https://x.test", poll_options: ["A", "B", "C"] },
    FINISHED_FLOW,
  );
  const form = calls[0].form;
  assert.equal(form.reply_to_id, "r1");
  assert.equal(form.quote_post_id, "q1");
  assert.equal(form.link_attachment, "https://x.test");
  assert.deepEqual(JSON.parse(form.poll_attachment), { option_a: "A", option_b: "B", option_c: "C" });
});

test("publish_thread IMAGE and VIDEO send their media url and alt text", async () => {
  const image = await runWithResponses("publish_thread", { media_type: "IMAGE", image_url: "https://i.test/a.jpg", alt_text: "cat" }, FINISHED_FLOW);
  assert.equal(image.calls[0].form.media_type, "IMAGE");
  assert.equal(image.calls[0].form.image_url, "https://i.test/a.jpg");
  assert.equal(image.calls[0].form.alt_text, "cat");
  const video = await runWithResponses("publish_thread", { media_type: "VIDEO", video_url: "https://v.test/a.mp4" }, FINISHED_FLOW);
  assert.equal(video.calls[0].form.media_type, "VIDEO");
  assert.equal(video.calls[0].form.video_url, "https://v.test/a.mp4");
});

test("publish_thread CAROUSEL creates carousel item children, then the parent", async () => {
  const { calls, output } = await runWithResponses(
    "publish_thread",
    { media_type: "CAROUSEL", text: "set", carousel_items: [{ image_url: "https://i.test/1.jpg", alt_text: "one" }, { video_url: "https://v.test/2.mp4" }] },
    [
      { body: { id: "child1" } },
      { body: { status: "FINISHED" } },
      { body: { id: "child2" } },
      { body: { status: "FINISHED" } },
      { body: { id: "parent" } },
      { body: { status: "FINISHED" } },
      { body: { id: "post" } },
    ],
  );
  assert.equal(calls[0].form.is_carousel_item, "true");
  assert.equal(calls[0].form.media_type, "IMAGE");
  assert.equal(calls[0].form.alt_text, "one");
  assert.equal(calls[2].form.media_type, "VIDEO");
  assert.equal(calls[2].form.video_url, "https://v.test/2.mp4");
  assert.equal(calls[4].form.media_type, "CAROUSEL");
  assert.equal(calls[4].form.children, "child1,child2");
  assert.equal(calls[4].form.text, "set");
  assert.equal(calls[6].path, "/v1.0/me/threads_publish");
  assert.equal(calls[6].form.creation_id, "parent");
  assert.deepEqual(output.data, { id: "post", container_id: "parent" });
});

for (const failedStatus of ["ERROR", "EXPIRED"]) {
  test(`publish_thread reports a ${failedStatus} container as api_error and does not publish`, async () => {
    const responses = [{ body: { id: "c" } }, { body: { status: failedStatus, error_message: "FAILED_DOWNLOADING_VIDEO" } }];
    await assert.rejects(
      runWithResponses("publish_thread", { media_type: "VIDEO", video_url: "https://v.test/a.mp4" }, responses),
      (error) => error.kind === "api_error" && error.message.includes(failedStatus) && /FAILED_DOWNLOADING_VIDEO/.test(error.message),
    );
  });
}

const twentyOneItems = Array.from({ length: 21 }, (_, index) => ({ image_url: `https://i.test/${index}.jpg` }));

for (const [label, invalidArgs] of [
  ["TEXT without text", { media_type: "TEXT" }],
  ["text over 500 characters", { text: "a".repeat(501) }],
  ["IMAGE without image_url", { media_type: "IMAGE" }],
  ["VIDEO without video_url", { media_type: "VIDEO" }],
  ["CAROUSEL with one item", { media_type: "CAROUSEL", carousel_items: [{ image_url: "https://i.test/1.jpg" }] }],
  ["CAROUSEL with 21 items", { media_type: "CAROUSEL", carousel_items: twentyOneItems }],
  ["CAROUSEL item without media", { media_type: "CAROUSEL", carousel_items: [{}, {}] }],
  ["one poll option", { text: "q", poll_options: ["A"] }],
  ["five poll options", { text: "q", poll_options: ["A", "B", "C", "D", "E"] }],
]) {
  test(`publish_thread rejects ${label}`, async () => {
    await assert.rejects(runWithResponses("publish_thread", invalidArgs, []), (error) => error.kind === "invalid_input");
  });
}

test("publish_thread accepts exactly 500 characters", async () => {
  const { calls } = await runWithResponses("publish_thread", { text: "a".repeat(500) }, FINISHED_FLOW);
  assert.equal(calls[0].form.text.length, 500);
});

test("publish_thread counts characters, not UTF-16 units, toward the 500 limit", async () => {
  const { calls } = await runWithResponses("publish_thread", { text: "😀".repeat(500) }, FINISHED_FLOW);
  assert.equal(calls.length, 3);
});
