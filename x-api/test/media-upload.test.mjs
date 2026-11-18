import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeResolver, runExpectingFailure, runWithResponses, rejectsWithKind, TEST_ENVIRONMENT } from "./helpers.mjs";

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

test("upload_media follows redirects hop by hop and checks every hop", async () => {
  const redirect = (location) => ({ status: 302, body: "", headers: { location } });
  const { calls } = await runWithResponses("upload_media", { image_url: "https://img.test/a.png" }, [redirect("https://cdn.test/a.png"), IMAGE_RESPONSE, UPLOAD_RESPONSE]);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://img.test/a.png", "https://cdn.test/a.png", "https://api.x.com/2/media/upload"],
  );
});

test("upload_media refuses a redirect to http or to an internal host", async () => {
  const toHttp = [{ status: 301, body: "", headers: { location: "http://img.test/a.png" } }];
  const { error: httpError, calls: httpCalls } = await runExpectingFailure("upload_media", { image_url: "https://img.test/a.png" }, toHttp);
  assert.equal(httpError.kind, "invalid_input");
  assert.match(httpError.message, /https/);
  assert.equal(httpCalls.length, 1);
  const toInternal = [{ status: 302, body: "", headers: { location: "https://internal.test/a.png" } }];
  const resolver = createFakeResolver({ "internal.test": ["10.0.0.5"] });
  const { error: internalError, calls: internalCalls } = await runExpectingFailure("upload_media", { image_url: "https://img.test/a.png" }, toInternal, TEST_ENVIRONMENT, resolver);
  assert.equal(internalError.kind, "invalid_input");
  assert.match(internalError.message, /public hosts/);
  assert.equal(internalCalls.length, 1);
});

for (const [label, imageUrl, addressesByHost] of [
  ["localhost", "https://localhost/a.png", {}],
  ["a loopback IP", "https://127.0.0.1/a.png", {}],
  ["a link-local IP", "https://169.254.169.254/latest", {}],
  ["an IPv6 loopback", "https://[::1]/a.png", {}],
  ["a host resolving to a private address", "https://lan.test/a.png", { "lan.test": ["93.184.216.34", "192.168.1.10"] }],
]) {
  test(`upload_media refuses ${label} without requesting it`, async () => {
    const { error, calls } = await runExpectingFailure("upload_media", { image_url: imageUrl }, [IMAGE_RESPONSE], TEST_ENVIRONMENT, createFakeResolver(addressesByHost));
    assert.equal(error.kind, "invalid_input");
    assert.match(error.message, /public hosts/);
    assert.equal(calls.length, 0);
  });
}

test("upload_media stops after too many redirects", async () => {
  const loop = Array.from({ length: 10 }, () => ({ status: 302, body: "", headers: { location: "https://img.test/again.png" } }));
  const { error, calls } = await runExpectingFailure("upload_media", { image_url: "https://img.test/a.png" }, loop);
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /redirected more than/);
  assert.equal(calls.length, 6);
});
