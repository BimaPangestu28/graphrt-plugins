import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { pluginDefinition } from "../definition.mjs";
import { createFakeResolver, createTestDefinition, runWithResponses, TEST_ENVIRONMENT } from "./helpers.mjs";

const IMAGE_URL = "https://cdn.test/cat.png";
const UPLOAD_URL = "https://www.linkedin.com/dms-uploads/abc?ca=vector_feedshare";
const imageResponse = { body: "PNGBYTES", headers: { "content-type": "image/png" } };
const initializeResponse = (uploadUrl = UPLOAD_URL) => ({
  body: { value: { uploadUrl, image: "urn:li:image:C1", uploadUrlExpiresAt: 1700000000000 } },
});

test("upload_image downloads the image, initializes the upload, then PUTs the bytes", async () => {
  const { output, calls } = await runWithResponses("upload_image", { image_url: IMAGE_URL }, [
    imageResponse,
    initializeResponse(),
    { status: 201, body: "" },
  ]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ["GET https://cdn.test/cat.png", "POST https://api.linkedin.com/rest/images?action=initializeUpload", `PUT ${UPLOAD_URL}`],
  );
  assert.equal(calls[0].headers.authorization, undefined, "the token must not go to the image host");
  assert.deepEqual(calls[1].json, { initializeUploadRequest: { owner: "urn:li:organization:42" } });
  assert.equal(calls[2].headers.authorization, "Bearer li-token");
  assert.deepEqual(output.data, { image_urn: "urn:li:image:C1", owner: "urn:li:organization:42", upload_url_expires_at: 1700000000000 });
});

test("upload_image uses owner_urn when given", async () => {
  const { calls } = await runWithResponses("upload_image", { image_url: IMAGE_URL, owner_urn: "urn:li:person:abc" }, [
    imageResponse,
    initializeResponse(),
    { status: 201, body: "" },
  ]);
  assert.equal(calls[1].json.initializeUploadRequest.owner, "urn:li:person:abc");
});

test("upload_image refuses an upload URL outside linkedin.com and never sends the token there", async () => {
  for (const foreignUploadUrl of ["https://evil.test/upload", "https://notlinkedin.com/upload", "http://www.linkedin.com/upload"]) {
    const recordingFetch = createRecordingFetch([imageResponse, initializeResponse(foreignUploadUrl), { status: 201 }]);
    const runOperation = createOperationRunner(createTestDefinition(), TEST_ENVIRONMENT, { fetchImpl: recordingFetch });
    await assert.rejects(
      runOperation("upload_image", { image_url: IMAGE_URL }, { source: "tool" }),
      (error) => error.kind === "api_error" && /linkedin\.com/.test(error.message),
    );
    assert.equal(recordingFetch.calls.length, 2, `no PUT to ${foreignUploadUrl}`);
  }
});

for (const [label, args, responses, expectedMessage] of [
  ["a non-https image_url", { image_url: "http://cdn.test/cat.png" }, [], /https/],
  ["a non-image download", { image_url: IMAGE_URL }, [{ body: "<html>", headers: { "content-type": "text/html" } }], /JPEG, PNG or GIF/],
  ["a WebP image", { image_url: IMAGE_URL }, [{ body: "RIFF", headers: { "content-type": "image/webp" } }], /JPEG, PNG or GIF/],
  ["an SVG image", { image_url: IMAGE_URL }, [{ body: "<svg/>", headers: { "content-type": "image/svg+xml" } }], /JPEG, PNG or GIF/],
  [
    "a Content-Length above 10 MB",
    { image_url: IMAGE_URL },
    [{ body: "x", headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) } }],
    /10 MB/,
  ],
  ["a body above 10 MB", { image_url: IMAGE_URL }, [{ body: "x".repeat(10 * 1024 * 1024 + 1), headers: { "content-type": "image/jpeg" } }], /10 MB/],
  ["a failed download", { image_url: IMAGE_URL }, [{ status: 404, body: "missing", headers: { "content-type": "text/plain" } }], /HTTP 404/],
]) {
  test(`upload_image rejects ${label} with invalid_input before initializing`, async () => {
    await assert.rejects(runWithResponses("upload_image", args, responses), (error) => error.kind === "invalid_input" && expectedMessage.test(error.message));
  });
}

test("upload_image maps a failed PUT to an error kind", async () => {
  await assert.rejects(
    runWithResponses("upload_image", { image_url: IMAGE_URL }, [imageResponse, initializeResponse(), { status: 403, body: "denied", headers: { "content-type": "text/plain" } }]),
    (error) => error.kind === "permission_denied" && /403/.test(error.message),
  );
});

test("upload_image fails clearly when initializeUpload returns no upload URL", async () => {
  await assert.rejects(
    runWithResponses("upload_image", { image_url: IMAGE_URL }, [imageResponse, { body: { value: {} } }]),
    (error) => error.kind === "api_error",
  );
});

test("upload_image accepts image/jpeg and image/gif with parameters in the content type", async () => {
  for (const contentType of ["image/jpeg", "IMAGE/GIF; charset=binary"]) {
    const { calls } = await runWithResponses("upload_image", { image_url: IMAGE_URL }, [
      { body: "BYTES", headers: { "content-type": contentType } },
      initializeResponse(),
      { status: 201, body: "" },
    ]);
    assert.equal(calls.length, 3, contentType);
  }
});

test("upload_image follows redirects by hand, checking every hop", async () => {
  const { calls } = await runWithResponses("upload_image", { image_url: IMAGE_URL }, [
    { status: 302, body: "", headers: { location: "https://img.test/real.png" } },
    imageResponse,
    initializeResponse(),
    { status: 201, body: "" },
  ]);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.url), [IMAGE_URL, "https://img.test/real.png"]);
});

for (const [label, args, responses, addressesByHost, expectedMessage] of [
  ["a redirect to http", { image_url: IMAGE_URL }, [{ status: 301, body: "", headers: { location: "http://img.test/a.png" } }], {}, /https/],
  ["a redirect to a private host", { image_url: IMAGE_URL }, [{ status: 307, body: "", headers: { location: "https://intranet.test/a.png" } }], { "intranet.test": ["10.0.0.5"] }, /public/],
  ["a loopback host", { image_url: "https://127.0.0.1/a.png" }, [imageResponse], {}, /public/],
  ["a localhost name", { image_url: "https://localhost/a.png" }, [imageResponse], {}, /public/],
  ["a host resolving to link-local", { image_url: "https://meta.test/a.png" }, [imageResponse], { "meta.test": ["169.254.169.254"] }, /public/],
  ["a redirect without Location", { image_url: IMAGE_URL }, [{ status: 302, body: "" }], {}, /Location/],
  ["too many redirects", { image_url: IMAGE_URL }, Array.from({ length: 7 }, () => ({ status: 302, body: "", headers: { location: IMAGE_URL } })), {}, /redirected more than/],
]) {
  test(`upload_image refuses ${label} with invalid_input`, async () => {
    await assert.rejects(
      runWithResponses("upload_image", args, responses, TEST_ENVIRONMENT, createFakeResolver(addressesByHost)),
      (error) => error.kind === "invalid_input" && expectedMessage.test(error.message),
    );
  });
}

test("upload_image fits in the tool deadline: download 60 s + initializeUpload + PUT 60 s", () => {
  assert.ok(pluginDefinition.limits?.timeout_ms - 10000 >= 60000 + 60000 + 30000 + 10000, `timeout_ms ${pluginDefinition.limits?.timeout_ms}`);
});
