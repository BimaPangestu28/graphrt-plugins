import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithResponses, rejectsWithKind } from "./helpers.mjs";

const IMAGE_RESPONSE = { body: "PNGBYTES", headers: { "content-type": "image/png" } };
const UPLOAD_RESPONSE = { body: { data: { id: "1880", media_key: "3_1880", size: 8 } } };

test("upload_media downloads the image without credentials, then uploads it as multipart", async () => {
  const { output, calls, rawBodies } = await runWithResponses("upload_media", { image_url: "https://img.test/a.png" }, [IMAGE_RESPONSE, UPLOAD_RESPONSE]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ["GET https://img.test/a.png", "POST https://api.x.com/2/media/upload"],
  );
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[1].headers.authorization, "Bearer user-token");
  assert.equal(calls[1].headers["content-type"], undefined, "fetch must set the multipart boundary itself");
  const uploadForm = rawBodies[1];
  assert.ok(uploadForm instanceof FormData);
  assert.equal(uploadForm.get("media_category"), "tweet_image");
  const uploadedFile = uploadForm.get("media");
  assert.equal(uploadedFile.type, "image/png");
  assert.equal(await uploadedFile.text(), "PNGBYTES");
  assert.deepEqual(output.data, UPLOAD_RESPONSE.body);
});

test("upload_media passes dm_image as the media category", async () => {
  const { rawBodies } = await runWithResponses("upload_media", { image_url: "https://img.test/a.jpg", media_category: "dm_image" }, [
    { body: "JPG", headers: { "content-type": "image/jpeg" } },
    UPLOAD_RESPONSE,
  ]);
  assert.equal(rawBodies[1].get("media_category"), "dm_image");
});

test("upload_media only downloads https URLs", async () => {
  await rejectsWithKind(assert, runWithResponses("upload_media", { image_url: "http://img.test/a.png" }), "invalid_input", /https/);
  await rejectsWithKind(assert, runWithResponses("upload_media", { image_url: "not a url" }), "invalid_input", /image_url/);
});

test("upload_media rejects non-image content", async () => {
  await rejectsWithKind(
    assert,
    runWithResponses("upload_media", { image_url: "https://img.test/page" }, [{ body: "<html>", headers: { "content-type": "text/html" } }]),
    "invalid_input",
    /image/,
  );
});

test("upload_media rejects images over 5 MB, by header and by actual size", async () => {
  const oversizedHeader = { body: "small", headers: { "content-type": "image/png", "content-length": String(6 * 1024 * 1024) } };
  await rejectsWithKind(assert, runWithResponses("upload_media", { image_url: "https://img.test/big.png" }, [oversizedHeader]), "invalid_input", /5 MB/);
  const oversizedBody = { body: "x".repeat(5 * 1024 * 1024 + 1), headers: { "content-type": "image/png" } };
  await rejectsWithKind(assert, runWithResponses("upload_media", { image_url: "https://img.test/big.png" }, [oversizedBody]), "invalid_input", /5 MB/);
});

test("upload_media reports a failed download", async () => {
  await rejectsWithKind(assert, runWithResponses("upload_media", { image_url: "https://img.test/missing.png" }, [{ status: 404, body: "nope" }]), "invalid_input", /404/);
});

test("upload_media fails when X returns no media id", async () => {
  await rejectsWithKind(assert, runWithResponses("upload_media", { image_url: "https://img.test/a.png" }, [IMAGE_RESPONSE, { body: {} }]), "api_error", /media id/);
});
