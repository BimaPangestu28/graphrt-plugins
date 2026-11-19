/**
 * Single-image operations for the google-vision plugin: OCR, labels, faces, safe search and any feature mix.
 *
 * Vision's images:annotate takes the image inline as base64 (`image.content`) or as a Cloud Storage URI. The
 * declarative layer cannot read a file into a base64 JSON field, so these operations are hand-written on the
 * plugin's own client (same API key header, redaction, retries and error mapping). An https image is downloaded by
 * the plugin with the shared public-https checks (no private or metadata hosts, size cap, no credential), so Google
 * never fetches arbitrary URLs on an agent's behalf; local files are read only inside GOOGLE_VISION_UPLOAD_DIR.
 *
 * Every annotate call is billed per feature, so it is sent as unsafe: a 5xx or timeout is never retried and the
 * error says how to check (429 is still retried: nothing ran).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { readFileInput } from "./shared/rest-files.mjs";
import { truncateForTool } from "./shared/rest-response.mjs";

// The JSON request limit is 10 MB, and base64 adds a third.
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
export const FEATURE_TYPES = [
  "TEXT_DETECTION",
  "DOCUMENT_TEXT_DETECTION",
  "LABEL_DETECTION",
  "FACE_DETECTION",
  "SAFE_SEARCH_DETECTION",
  "LANDMARK_DETECTION",
  "LOGO_DETECTION",
  "OBJECT_LOCALIZATION",
  "IMAGE_PROPERTIES",
  "CROP_HINTS",
  "WEB_DETECTION",
];
const TOOL_OUTPUT = { maxItems: 50, maxChars: 100000 };
export const PAID_CHECK_HINT = "the image may have been billed; check the API's usage in the Cloud console before retrying";
const UNKNOWN_OUTCOME_MARKER = "outcome unknown";
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const KINDS_BY_RPC_CODE = { 3: "invalid_input", 5: "not_found", 7: "permission_denied", 8: "rate_limited", 16: "auth_error" };
const IMAGE_PROPERTIES = {
  image: { type: "string", description: "An https URL (downloaded by the plugin), a gs:// URI, or an absolute path inside GOOGLE_VISION_UPLOAD_DIR" },
  image_base64: { type: "string", description: "The image as base64 (or a data: URL) instead of image" },
};
const MAX_RESULTS_PROPERTY = { type: "integer", minimum: 1, maximum: 100, description: "Maximum results per feature" };

/**
 * Builds the hand-written image operations.
 *
 * @returns Operations `{name, title, description, parameters, run}` for operations.mjs (object[])
 */
export function createImageOperations() {
  return [detectTextOperation(), detectLabelsOperation(), detectFacesOperation(), detectSafeSearchOperation(), analyzeImageOperation()];
}

function imageOperation({ name, title, description, properties = {}, buildFeatures, pickResult }) {
  return {
    name,
    title,
    description,
    parameters: { type: "object", properties: { ...IMAGE_PROPERTIES, ...properties }, required: [] },
    run: async (context) => {
      const imageResponse = await annotateOneImage(context, buildFeatures(context.args), context.args.language_hints);
      const result = pickResult(imageResponse, context.args);
      return { data: context.source === "tool" ? truncateForTool(result, TOOL_OUTPUT) : result, next_cursor: null };
    },
  };
}

function detectTextOperation() {
  return imageOperation({
    name: "detect_text",
    title: "Read text (OCR)",
    description: "OCR an image: returns {text, locale}. mode dense (default) for documents and photos of pages, sparse for signs and labels",
    properties: {
      mode: { type: "string", enum: ["dense", "sparse"], default: "dense", description: "dense: DOCUMENT_TEXT_DETECTION, sparse: TEXT_DETECTION" },
      language_hints: { type: "array", items: { type: "string" }, maxItems: 10, description: "Language codes, e.g. [\"id\", \"en\"] (usually not needed)" },
    },
    buildFeatures: (args) => [{ type: args.mode === "sparse" ? "TEXT_DETECTION" : "DOCUMENT_TEXT_DETECTION" }],
    pickResult: (imageResponse) => ({ text: imageResponse.fullTextAnnotation?.text ?? imageResponse.textAnnotations?.[0]?.description ?? "", locale: imageResponse.textAnnotations?.[0]?.locale ?? null }),
  });
}

function detectLabelsOperation() {
  return imageOperation({
    name: "detect_labels",
    title: "Detect labels",
    description: "Describe what an image shows: [{label, score, topicality, mid}], best first",
    properties: { max_results: MAX_RESULTS_PROPERTY },
    buildFeatures: (args) => [withMaxResults("LABEL_DETECTION", args.max_results)],
    pickResult: (imageResponse) =>
      (imageResponse.labelAnnotations ?? []).map((labelAnnotation) => ({ label: labelAnnotation.description, score: labelAnnotation.score, topicality: labelAnnotation.topicality, mid: labelAnnotation.mid })),
  });
}

function detectFacesOperation() {
  return imageOperation({
    name: "detect_faces",
    title: "Detect faces",
    description: "Find faces with bounding boxes and emotion likelihoods (joy, sorrow, anger, surprise); no identity recognition",
    properties: { max_results: MAX_RESULTS_PROPERTY, include_landmarks: { type: "boolean", default: false, description: "Include the ~35 facial landmark points per face" } },
    buildFeatures: (args) => [withMaxResults("FACE_DETECTION", args.max_results)],
    pickResult: (imageResponse, args) =>
      (imageResponse.faceAnnotations ?? []).map((faceAnnotation) => {
        if (args.include_landmarks) return faceAnnotation;
        const { landmarks, ...faceWithoutLandmarks } = faceAnnotation;
        return faceWithoutLandmarks;
      }),
  });
}

function detectSafeSearchOperation() {
  return imageOperation({
    name: "detect_safe_search",
    title: "Safe search",
    description: "Likelihood that an image is adult, spoof, medical, violent or racy (VERY_UNLIKELY ... VERY_LIKELY)",
    buildFeatures: () => [{ type: "SAFE_SEARCH_DETECTION" }],
    pickResult: (imageResponse) => imageResponse.safeSearchAnnotation ?? null,
  });
}

function analyzeImageOperation() {
  return imageOperation({
    name: "analyze_image",
    title: "Analyze image",
    description: "Run several Vision features on one image (logos, landmarks, objects, colors, web matches, ...) and return Vision's response",
    properties: {
      features: { type: "array", items: { type: "string", enum: FEATURE_TYPES }, maxItems: FEATURE_TYPES.length, default: ["LABEL_DETECTION"], description: "Features to run" },
      max_results: MAX_RESULTS_PROPERTY,
      language_hints: { type: "array", items: { type: "string" }, maxItems: 10, description: "Language codes for text features" },
    },
    buildFeatures: (args) => [...new Set(args.features)].map((featureType) => withMaxResults(featureType, args.max_results)),
    pickResult: (imageResponse) => imageResponse,
  });
}

function withMaxResults(featureType, maxResults) {
  return maxResults === undefined ? { type: featureType } : { type: featureType, maxResults };
}

async function annotateOneImage(context, features, languageHints) {
  const image = await resolveImage(context);
  const imageRequest = { image, features, ...(languageHints?.length ? { imageContext: { languageHints } } : {}) };
  const response = await sendAnnotateRequest(context, imageRequest);
  const imageResponse = response.body?.responses?.[0] ?? {};
  if (imageResponse.error) throw describeImageError(imageResponse.error);
  return imageResponse;
}

async function sendAnnotateRequest(context, imageRequest) {
  try {
    return await context.client.requestWithHeaders({ method: "POST", path: "/v1/images:annotate", json: { requests: [imageRequest] }, idempotent: false, redactResponse: true, signal: context.signal });
  } catch (requestError) {
    if (!(requestError instanceof PluginError) || !requestError.message.includes(UNKNOWN_OUTCOME_MARKER)) throw requestError;
    throw new PluginError(`${requestError.message}. To check: ${PAID_CHECK_HINT}`, { kind: requestError.kind, retryable: false });
  }
}

/**
 * Wraps annotate_images so agent tool calls may only send inline `content` or gs:// images: an http(s) imageUri
 * would make Google fetch a URL of the agent's choosing. Workflow nodes are not limited.
 *
 * @param operation - The declarative annotate_images operation (object)
 * @returns Operation with the same schema and a guarded run (object)
 * @throws PluginError kind `permission_denied` - (from run) an http(s) imageUri in a tool call
 */
export function guardImageUris(operation) {
  return {
    ...operation,
    run: (context) => {
      if (context.source === "tool") assertNoRemoteImageUris(context.args.requests);
      return operation.run(context);
    },
  };
}

function assertNoRemoteImageUris(imageRequests) {
  for (const imageRequest of imageRequests ?? []) {
    const imageUri = imageRequest?.image?.source?.imageUri;
    if (imageUri === undefined || /^gs:\/\//.test(String(imageUri))) continue;
    throw new PluginError("Agent tools may only send image content or gs:// URIs to annotate_images; use detect_text/detect_labels/analyze_image with an https image (the plugin downloads it with public-host checks)", {
      kind: "permission_denied",
    });
  }
}

/**
 * Turns the operation's image arguments into Vision's `image` object.
 *
 * @param context - Operation context with `args`, `client`, `environment`, `signal` (object)
 * @returns `{content}` (base64) or `{source: {imageUri}}` for gs:// (Promise<object>)
 * @throws PluginError kind `invalid_input` - No image, both kinds, bad base64, too large, or a refused file
 */
export async function resolveImage({ args, client, environment, signal }) {
  const hasImage = typeof args.image === "string" && args.image !== "";
  const hasBase64 = typeof args.image_base64 === "string" && args.image_base64 !== "";
  if (hasImage === hasBase64) throw new PluginError("Pass exactly one of `image` or `image_base64`", { kind: "invalid_input" });
  if (hasBase64) return { content: checkBase64Image(args.image_base64) };
  if (/^gs:\/\/[^/]+\/.+/.test(args.image)) return { source: { imageUri: args.image } };
  const fileInput = await readFileInput(args.image, {
    paramName: "image",
    fileDirEnv: "GOOGLE_VISION_UPLOAD_DIR",
    environment,
    maxBytes: MAX_IMAGE_BYTES,
    fetchImpl: client.fetchImpl,
    resolveHostAddresses: client.resolveHostAddresses,
    signal,
  });
  return { content: Buffer.from(fileInput.bytes).toString("base64") };
}

function checkBase64Image(encodedImage) {
  const base64Text = encodedImage.replace(/^data:[\w.+-]+\/[\w.+-]+;base64,/, "").replace(/\s+/g, "");
  if (!BASE64_TEXT.test(base64Text)) throw new PluginError("`image_base64` is not base64", { kind: "invalid_input" });
  if ((base64Text.length * 3) / 4 > MAX_IMAGE_BYTES) throw new PluginError(`\`image_base64\` is larger than ${MAX_IMAGE_BYTES} bytes`, { kind: "invalid_input" });
  return base64Text;
}

function describeImageError(imageError) {
  const kind = KINDS_BY_RPC_CODE[imageError.code] ?? "api_error";
  return new PluginError(`Vision could not process the image: ${imageError.message ?? "unknown error"}`, { kind, retryable: kind === "rate_limited" });
}
