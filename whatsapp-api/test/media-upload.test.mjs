import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeResolver, runWithResponses, rejectsWithKind } from "./helpers.mjs";

const IMAGE_RESPONSE = { body: "JPEGBYTES", headers: { "content-type": "image/jpeg" } };
const UPLOAD_RESPONSE = { body: { id: "media-1" } };

test("upload_media downloads without credentials, then uploads multipart to /{phone-number-id}/media", async () => {
  const { output, calls, rawBodies } = await runWithResponses("upload_media", { url: "https://img.test/a.jpg", type: "image" }, [IMAGE_RESPONSE, UPLOAD_RESPONSE]);
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url}`),
    ["GET https://img.test/a.jpg", "POST https://graph.facebook.com/v26.0/111/media"],
  );
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[1].headers.authorization, "Bearer wa-token");
  assert.equal(calls[1].headers["content-type"], undefined, "fetch must set the multipart boundary itself");
  const uploadForm = rawBodies[1];
  assert.ok(uploadForm instanceof FormData);
  assert.equal(uploadForm.get("messaging_product"), "whatsapp");
  assert.equal(uploadForm.get("type"), "image/jpeg");
  const uploadedFile = uploadForm.get("file");
  assert.equal(uploadedFile.type, "image/jpeg");
  assert.equal(await uploadedFile.text(), "JPEGBYTES");
  assert.deepEqual(output.data, { id: "media-1", mime_type: "image/jpeg", file_size: 9 });
});

test("upload_media uses mime_type when the server sends a generic content type", async () => {
  const { rawBodies } = await runWithResponses("upload_media", { url: "https://files.test/inv.pdf", type: "document", mime_type: "application/pdf", filename: "inv.pdf" }, [
    { body: "%PDF", headers: { "content-type": "application/octet-stream" } },
    UPLOAD_RESPONSE,
  ]);
  assert.equal(rawBodies[1].get("type"), "application/pdf");
  assert.equal(rawBodies[1].get("file").name, "inv.pdf");
});

test("upload_media only downloads https URLs", async () => {
  await rejectsWithKind(assert, runWithResponses("upload_media", { url: "http://img.test/a.jpg", type: "image" }, []), "invalid_input", /https/);
  await rejectsWithKind(assert, runWithResponses("upload_media", { url: "not a url", type: "image" }, []), "invalid_input", /url/);
});

test("upload_media rejects a content type that does not fit the media type", async () => {
  await rejectsWithKind(
    assert,
    runWithResponses("upload_media", { url: "https://img.test/page", type: "image" }, [{ body: "<html>", headers: { "content-type": "text/html" } }]),
    "invalid_input",
    /text\/html/,
  );
});

for (const [mediaType, mimeType, limitText, oversizedBytes] of [
  ["image", "image/png", "5 MB", 5 * 1024 * 1024 + 1],
  ["sticker", "image/webp", "500 KB", 500 * 1024 + 1],
  ["audio", "audio/mpeg", "16 MB", 16 * 1024 * 1024 + 1],
]) {
  test(`upload_media rejects ${mediaType} over ${limitText}, by header and by actual size`, async () => {
    const oversizedHeader = { body: "small", headers: { "content-type": mimeType, "content-length": String(oversizedBytes) } };
    await rejectsWithKind(assert, runWithResponses("upload_media", { url: "https://f.test/x", type: mediaType }, [oversizedHeader]), "invalid_input", new RegExp(limitText));
    const oversizedBody = { body: "x".repeat(oversizedBytes), headers: { "content-type": mimeType } };
    await rejectsWithKind(assert, runWithResponses("upload_media", { url: "https://f.test/x", type: mediaType }, [oversizedBody]), "invalid_input", new RegExp(limitText));
  });
}

test("upload_media reports a failed download", async () => {
  await rejectsWithKind(assert, runWithResponses("upload_media", { url: "https://img.test/missing.jpg", type: "image" }, [{ status: 404, body: "nope" }]), "invalid_input", /404/);
});

test("upload_media fails when WhatsApp returns no media id", async () => {
  await rejectsWithKind(assert, runWithResponses("upload_media", { url: "https://img.test/a.jpg", type: "image" }, [IMAGE_RESPONSE, { body: {} }]), "api_error", /media id/);
});

test("upload_media gives the upload POST a longer timeout than the 30 s default", async () => {
  const { mediaOperations, UPLOAD_TIMEOUT_MS } = await import("../operations/media.mjs");
  const uploadOperation = mediaOperations.find((operation) => operation.name === "upload_media");
  const requests = [];
  const fakeClient = {
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    request: async (requestOptions) => (requests.push(requestOptions), { id: "media-1" }),
    resolveHostAddresses: createFakeResolver(),
  };
  await uploadOperation.run({ client: fakeClient, args: { url: "https://cdn.example.com/a.png", type: "image" }, environment: { WHATSAPP_PHONE_NUMBER_ID: "123" } });
  assert.ok(UPLOAD_TIMEOUT_MS > 30000);
  assert.equal(requests[0].timeoutMs, UPLOAD_TIMEOUT_MS);
});

test("a download that stalls mid-body becomes network_error, and a cancel mid-body becomes cancelled", async () => {
  const { downloadMedia } = await import("../lib/media-download.mjs");
  const stallingFetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.error(new DOMException("The operation timed out.", "TimeoutError"));
        },
      }),
      { headers: { "content-type": "image/png" } },
    );
  await assert.rejects(downloadMedia(stallingFetch, { url: "https://cdn.example.com/a.png", mediaType: "image", resolveHostAddresses: createFakeResolver() }), (error) => error.kind === "network_error");
  await assert.rejects(
    downloadMedia(stallingFetch, { url: "https://cdn.example.com/a.png", mediaType: "image", signal: AbortSignal.abort(), resolveHostAddresses: createFakeResolver() }),
    (error) => error.kind === "cancelled",
  );
});

test("upload_media ignores mime_type when the server reports a specific type", async () => {
  const { rawBodies, output } = await runWithResponses("upload_media", { url: "https://img.test/a", type: "image", mime_type: "image/jpeg" }, [
    { body: "PNG", headers: { "content-type": "image/png" } },
    UPLOAD_RESPONSE,
  ]);
  assert.equal(rawBodies[1].get("type"), "image/png");
  assert.equal(output.data.mime_type, "image/png");
  await rejectsWithKind(
    assert,
    runWithResponses("upload_media", { url: "https://img.test/page", type: "image", mime_type: "image/jpeg" }, [{ body: "<html>", headers: { "content-type": "text/html" } }]),
    "invalid_input",
    /text\/html/,
  );
});

test("upload_media uses mime_type when the server reports no content type", async () => {
  const noTypeFetch = async () => new Response(new Uint8Array([1, 2]), { headers: {} });
  const { downloadMedia } = await import("../lib/media-download.mjs");
  const fileBlob = await downloadMedia(noTypeFetch, { url: "https://img.test/a", mediaType: "image", mimeTypeOverride: "image/png", resolveHostAddresses: createFakeResolver() });
  assert.equal(fileBlob.type, "image/png");
});

test("upload_media accepts the image types the Cloud API lists: JPEG, PNG and static WebP", async () => {
  for (const mimeType of ["image/jpeg", "image/png", "image/webp"]) {
    const { rawBodies } = await runWithResponses("upload_media", { url: "https://img.test/a", type: "image" }, [{ body: "x", headers: { "content-type": mimeType } }, UPLOAD_RESPONSE]);
    assert.equal(rawBodies[1].get("type"), mimeType);
  }
  await rejectsWithKind(assert, runWithResponses("upload_media", { url: "https://img.test/a", type: "image" }, [{ body: "x", headers: { "content-type": "image/gif" } }]), "invalid_input", /image\/gif/);
});

test("upload_media gives the default file name an extension from the MIME type", async () => {
  for (const [mediaType, mimeType, expectedName] of [
    ["image", "image/jpeg", "upload.jpg"],
    ["audio", "audio/mpeg", "upload.mp3"],
    ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "upload.docx"],
    ["sticker", "image/webp", "upload.webp"],
  ]) {
    const { rawBodies } = await runWithResponses("upload_media", { url: "https://f.test/download", type: mediaType }, [{ body: "x", headers: { "content-type": mimeType } }, UPLOAD_RESPONSE]);
    assert.equal(rawBodies[1].get("file").name, expectedName, mimeType);
  }
});

test("upload_media follows redirects by hand, checking every hop", async () => {
  const { calls } = await runWithResponses("upload_media", { url: "https://img.test/a.jpg", type: "image" }, [
    { status: 302, body: "", headers: { location: "https://cdn.test/real.jpg" } },
    IMAGE_RESPONSE,
    UPLOAD_RESPONSE,
  ]);
  assert.deepEqual(calls.map((call) => call.url).slice(0, 2), ["https://img.test/a.jpg", "https://cdn.test/real.jpg"]);
});

for (const [label, url, responses, addressesByHost, expectedMessage] of [
  ["a redirect to http", "https://img.test/a.jpg", [{ status: 301, body: "", headers: { location: "http://img.test/a.jpg" } }], {}, /https/],
  ["a redirect to a private host", "https://img.test/a.jpg", [{ status: 308, body: "", headers: { location: "https://nas.test/a.jpg" } }], { "nas.test": ["192.168.1.2"] }, /public/],
  ["a loopback address", "https://127.0.0.1/a.jpg", [IMAGE_RESPONSE], {}, /public/],
  ["an IPv6 loopback address", "https://[::1]/a.jpg", [IMAGE_RESPONSE], {}, /public/],
  ["a host resolving to link-local", "https://meta.test/a.jpg", [IMAGE_RESPONSE], { "meta.test": ["169.254.169.254"] }, /public/],
  ["too many redirects", "https://img.test/a.jpg", Array.from({ length: 7 }, () => ({ status: 302, body: "", headers: { location: "https://img.test/a.jpg" } })), {}, /redirected more than/],
]) {
  test(`upload_media refuses ${label} with invalid_input`, async () => {
    await rejectsWithKind(
      assert,
      runWithResponses("upload_media", { url, type: "image" }, responses, undefined, createFakeResolver(addressesByHost)),
      "invalid_input",
      expectedMessage,
    );
  });
}
