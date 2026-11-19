import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";

const API_KEY = "vision-test-key-0001";
const ANNOTATE_URL = "https://vision.googleapis.com/v1/images:annotate";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const uploadDirectory = mkdtempSync(join(tmpdir(), "vision-upload-"));
const localImage = join(uploadDirectory, "receipt.png");
writeFileSync(localImage, PNG_BYTES);
after(() => rmSync(uploadDirectory, { recursive: true, force: true }));

function createVisionFetch(annotateResponses) {
  const remaining = [...annotateResponses];
  const calls = [];
  const visionFetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, json: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (String(url).startsWith("https://images.example.org/")) return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    const { status = 200, body } = remaining.shift() ?? { body: { responses: [{}] } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  visionFetch.calls = calls;
  return visionFetch;
}

async function runVision(operationName, args, annotateResponses, { source = "tool", environment = {} } = {}) {
  const visionFetch = createVisionFetch(annotateResponses);
  const run = createOperationRunner(pluginDefinition, { GOOGLE_VISION_API_KEY: API_KEY, GOOGLE_VISION_UPLOAD_DIR: uploadDirectory, ...environment }, { fetchImpl: visionFetch, resolveHostAddresses: async () => ["93.184.216.34"] });
  const outcome = await run(operationName, args, { source }).then((output) => ({ output }), (error) => ({ error }));
  return { ...outcome, calls: visionFetch.calls.filter((call) => call.url === ANNOTATE_URL), allCalls: visionFetch.calls };
}

test("detect_text sends a local file as base64 with DOCUMENT_TEXT_DETECTION and returns the text", async () => {
  const response = { responses: [{ fullTextAnnotation: { text: "TOTAL 42.00\n", pages: [{}] }, textAnnotations: [{ locale: "en", description: "TOTAL 42.00\n" }] }] };
  const { output, error, calls } = await runVision("detect_text", { image: localImage, language_hints: ["en"] }, [{ body: response }]);
  if (error) throw error;
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["x-goog-api-key"], API_KEY);
  assert.deepEqual(calls[0].json, {
    requests: [{ image: { content: PNG_BYTES.toString("base64") }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }], imageContext: { languageHints: ["en"] } }],
  });
  assert.deepEqual(output.data, { text: "TOTAL 42.00\n", locale: "en" });
});

test("detect_text mode sparse uses TEXT_DETECTION; an image without text gives empty text", async () => {
  const { output, calls } = await runVision("detect_text", { image: localImage, mode: "sparse" }, [{ body: { responses: [{}] } }]);
  assert.deepEqual(calls[0].json.requests[0].features, [{ type: "TEXT_DETECTION" }]);
  assert.deepEqual(output.data, { text: "", locale: null });
});

test("an https image is downloaded by the plugin (public hosts only) and sent inline; the key never goes there", async () => {
  const { error, calls, allCalls } = await runVision("detect_labels", { image: "https://images.example.org/cat.png" }, [{ body: { responses: [{ labelAnnotations: [] }] } }]);
  if (error) throw error;
  assert.equal(allCalls[0].url, "https://images.example.org/cat.png");
  assert.equal(allCalls[0].headers["x-goog-api-key"], undefined);
  assert.equal(calls[0].json.requests[0].image.content, PNG_BYTES.toString("base64"));
});

test("a gs:// image is passed to Vision as imageUri", async () => {
  const { calls } = await runVision("detect_labels", { image: "gs://bucket/cat.jpg", max_results: 3 }, [{ body: { responses: [{}] } }]);
  assert.deepEqual(calls[0].json.requests[0], { image: { source: { imageUri: "gs://bucket/cat.jpg" } }, features: [{ type: "LABEL_DETECTION", maxResults: 3 }] });
});

test("image_base64 is sent as is, and exactly one image source is required", async () => {
  const base64 = PNG_BYTES.toString("base64");
  const { calls } = await runVision("detect_safe_search", { image_base64: `data:image/png;base64,${base64}` }, [{ body: { responses: [{ safeSearchAnnotation: { adult: "VERY_UNLIKELY" } }] } }]);
  assert.equal(calls[0].json.requests[0].image.content, base64);
  const neither = await runVision("detect_safe_search", {}, []);
  assert.equal(neither.error?.kind, "invalid_input");
  const both = await runVision("detect_safe_search", { image: localImage, image_base64: base64 }, []);
  assert.equal(both.error?.kind, "invalid_input");
  assert.equal(both.calls.length, 0);
  const notBase64 = await runVision("detect_safe_search", { image_base64: "not base64 !!" }, []);
  assert.equal(notBase64.error?.kind, "invalid_input");
});

test("detect_labels returns label, score and topicality", async () => {
  const response = { responses: [{ labelAnnotations: [{ mid: "/m/01yrx", description: "Cat", score: 0.98, topicality: 0.98 }] }] };
  const { output } = await runVision("detect_labels", { image: localImage }, [{ body: response }]);
  assert.deepEqual(output.data, [{ label: "Cat", score: 0.98, topicality: 0.98, mid: "/m/01yrx" }]);
});

test("detect_faces drops the landmarks unless include_landmarks is true", async () => {
  const face = { detectionConfidence: 0.9, joyLikelihood: "VERY_LIKELY", sorrowLikelihood: "VERY_UNLIKELY", angerLikelihood: "UNLIKELY", surpriseLikelihood: "UNLIKELY", headwearLikelihood: "UNLIKELY", boundingPoly: { vertices: [] }, landmarks: [{ type: "LEFT_EYE" }] };
  const { output } = await runVision("detect_faces", { image: localImage }, [{ body: { responses: [{ faceAnnotations: [face] }] } }]);
  assert.equal("landmarks" in output.data[0], false);
  assert.equal(output.data[0].joyLikelihood, "VERY_LIKELY");
  const detailed = await runVision("detect_faces", { image: localImage, include_landmarks: true }, [{ body: { responses: [{ faceAnnotations: [face] }] } }]);
  assert.deepEqual(detailed.output.data[0].landmarks, [{ type: "LEFT_EYE" }]);
});

test("detect_safe_search returns the likelihoods", async () => {
  const annotation = { adult: "VERY_UNLIKELY", spoof: "UNLIKELY", medical: "UNLIKELY", violence: "UNLIKELY", racy: "POSSIBLE" };
  const { output } = await runVision("detect_safe_search", { image: localImage }, [{ body: { responses: [{ safeSearchAnnotation: annotation }] } }]);
  assert.deepEqual(output.data, annotation);
});

test("analyze_image runs several features and returns Vision's response for the image", async () => {
  const { output, calls } = await runVision("analyze_image", { image: localImage, features: ["LOGO_DETECTION", "OBJECT_LOCALIZATION"], max_results: 5 }, [{ body: { responses: [{ logoAnnotations: [] }] } }]);
  assert.deepEqual(calls[0].json.requests[0].features, [{ type: "LOGO_DETECTION", maxResults: 5 }, { type: "OBJECT_LOCALIZATION", maxResults: 5 }]);
  assert.deepEqual(output.data, { logoAnnotations: [] });
});

test("a per-image error inside a 200 response becomes an error with Vision's message", async () => {
  const { error } = await runVision("detect_labels", { image: localImage }, [{ body: { responses: [{ error: { code: 3, message: "Bad image data." } }] } }]);
  assert.equal(error.kind, "invalid_input");
  assert.match(error.message, /Bad image data/);
});

test("an invalid key is an auth_error and the key is redacted", async () => {
  const body = { error: { code: 400, message: `API key not valid ${API_KEY}`, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } };
  const { error } = await runVision("detect_text", { image: localImage }, [{ status: 400, body }]);
  assert.equal(error.kind, "auth_error");
  assert.equal(error.message.includes(API_KEY), false);
});

test("local files outside GOOGLE_VISION_UPLOAD_DIR and non-https URLs are refused", async () => {
  const outside = await runVision("detect_text", { image: "/etc/hosts" }, []);
  assert.equal(outside.error?.kind, "invalid_input");
  const plainHttp = await runVision("detect_text", { image: "http://images.example.org/a.png" }, []);
  assert.equal(plainHttp.error?.kind, "invalid_input");
  assert.equal(plainHttp.allCalls.length, 0);
});

test("tool results are truncated, node results are not", async () => {
  const manyLabels = Array.from({ length: 200 }, (unused, index) => ({ description: `label ${index}`, score: 0.5 }));
  const asTool = await runVision("detect_labels", { image: localImage }, [{ body: { responses: [{ labelAnnotations: manyLabels }] } }]);
  assert.equal(asTool.output.data.truncated, true);
  const asNode = await runVision("detect_labels", { image: localImage }, [{ body: { responses: [{ labelAnnotations: manyLabels }] } }], { source: "node" });
  assert.equal(asNode.output.data.length, 200);
});

test("the image operations are agent tools", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  for (const toolName of ["detect_text", "detect_labels", "detect_faces", "detect_safe_search", "analyze_image", "annotate_images"]) assert.ok(toolNames.includes(toolName), toolName);
});

test("the image operations are never retried after a 5xx (the unit may have been billed) and say how to check", async () => {
  for (const operationName of ["detect_text", "detect_labels", "detect_faces", "detect_safe_search", "analyze_image"]) {
    const { error, calls } = await runVision(operationName, { image: localImage }, [{ status: 500, body: { error: { code: 500, message: "Internal" } } }, { body: { responses: [{}] } }]);
    assert.equal(calls.length, 1, operationName);
    assert.equal(error?.retryable, false, operationName);
    assert.match(error.message, /outcome unknown/);
    assert.match(error.message, /billed/);
  }
});

test("annotate_images refuses http(s) imageUri from agent tools (Google would fetch it), allows content and gs://", async () => {
  const urlRequest = { image: { source: { imageUri: "https://internal.example/x.png" } }, features: [{ type: "LABEL_DETECTION" }] };
  const refused = await runVision("annotate_images", { requests: [urlRequest] }, [{ body: { responses: [{}] } }]);
  assert.equal(refused.error?.kind, "permission_denied");
  assert.equal(refused.calls.length, 0);
  const allowed = await runVision("annotate_images", { requests: [{ image: { content: "iVBORw0K" }, features: [] }, { image: { source: { imageUri: "gs://b/x.png" } }, features: [] }, { image: { source: { gcsImageUri: "gs://b/y.png" } }, features: [] }] }, [{ body: { responses: [{}, {}, {}] } }]);
  if (allowed.error) throw allowed.error;
  const asNode = await runVision("annotate_images", { requests: [urlRequest] }, [{ body: { responses: [{}] } }], { source: "node" });
  if (asNode.error) throw asNode.error;
  assert.equal(asNode.calls.length, 1);
});

test("annotate_files takes exactly one file request", async () => {
  const fileRequest = { inputConfig: { content: "JVBERi0=", mimeType: "application/pdf" }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] };
  const { error, allCalls } = await runVision("annotate_files", { requests: [fileRequest, fileRequest] }, []);
  assert.equal(error?.kind, "invalid_input");
  assert.equal(allCalls.length, 0);
});
