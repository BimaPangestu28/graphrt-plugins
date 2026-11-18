import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses } from "./helpers.mjs";

const EXISTING_SNIPPET = {
  title: "Old title",
  description: "Old description",
  tags: ["a", "b"],
  categoryId: "22",
  defaultLanguage: "en",
  channelId: "UC1",
};

test("update_video_metadata reads the snippet, merges only the given fields, then PUTs it", async () => {
  const { output, calls } = await runWithResponses("update_video_metadata", { video_id: "v1", title: "New title" }, [
    { body: { items: [{ id: "v1", snippet: EXISTING_SNIPPET }] } },
    { body: { id: "v1", snippet: { ...EXISTING_SNIPPET, title: "New title" } } },
  ]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.path}`),
    ["GET /youtube/v3/videos", "PUT /youtube/v3/videos"],
  );
  assert.equal(calls[0].query.id, "v1");
  assert.equal(calls[0].query.part, "snippet");
  assert.equal(calls[1].query.part, "snippet");
  assert.deepEqual(calls[1].json, { id: "v1", snippet: { ...EXISTING_SNIPPET, title: "New title" } });
  assert.equal(output.data.snippet.title, "New title");
});

test("update_video_metadata maps description, tags and category_id", async () => {
  const { calls } = await runWithResponses("update_video_metadata", { video_id: "v1", description: "D", tags: ["x"], category_id: "10" }, [
    { body: { items: [{ id: "v1", snippet: EXISTING_SNIPPET }] } },
    { body: {} },
  ]);
  assert.deepEqual(calls[1].json.snippet, { ...EXISTING_SNIPPET, description: "D", tags: ["x"], categoryId: "10" });
});

test("update_video_metadata drops the read-only localized copy so it cannot overwrite the new title", async () => {
  const { calls } = await runWithResponses("update_video_metadata", { video_id: "v1", title: "T" }, [
    { body: { items: [{ id: "v1", snippet: { ...EXISTING_SNIPPET, localized: { title: "Old title", description: "Old description" } } }] } },
    { body: {} },
  ]);
  assert.equal(calls[1].json.snippet.localized, undefined);
});

test("update_video_metadata requires at least one field to change", async () => {
  await assert.rejects(runWithResponses("update_video_metadata", { video_id: "v1" }, []), (error) => error.kind === "invalid_input");
});

test("update_video_metadata fails with not_found when the video does not exist", async () => {
  await assert.rejects(runWithResponses("update_video_metadata", { video_id: "missing", title: "T" }, [{ body: { items: [] } }]), (error) => error.kind === "not_found");
});

test("update_video_metadata clears the description with clear_description: true", async () => {
  const { calls } = await runWithResponses("update_video_metadata", { video_id: "v1", clear_description: true }, [
    { body: { items: [{ id: "v1", snippet: EXISTING_SNIPPET }] } },
    { body: {} },
  ]);
  assert.equal(calls[1].json.snippet.description, "");
  assert.equal(calls[1].json.snippet.title, "Old title");
});

test("update_video_metadata refuses clear_description together with a description", async () => {
  await assert.rejects(
    runWithResponses("update_video_metadata", { video_id: "v1", description: "D", clear_description: true }, []),
    (error) => error.kind === "invalid_input" && /clear_description/.test(error.message),
  );
});

test("update_video_metadata with clear_description: false alone is not a change", async () => {
  await assert.rejects(runWithResponses("update_video_metadata", { video_id: "v1", clear_description: false }, []), (error) => error.kind === "invalid_input");
});
