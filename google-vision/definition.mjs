/**
 * google-vision plugin definition: Cloud Vision (https://cloud.google.com/vision/docs/reference/rest) with an API
 * key: OCR, labels, faces, safe search, logos, landmarks, objects and web matches.
 *
 * `annotate_images` and `annotate_files` are declarative pass-throughs of Vision's batch requests. The one-image
 * operations (detect_text, detect_labels, detect_faces, detect_safe_search, analyze_image) are hand-written in
 * lib/image-operations.mjs because they read an image (URL or local file) into a base64 JSON field.
 * Every operation is billed per image and feature, so all of them are "unsafe": a 5xx or timeout is when Google may
 * already have billed the call, so nothing is retried after an unknown outcome and the error says how to check.
 * For agent tools, annotate_images accepts only inline content or gs:// images (guardImageUris), so Google never
 * fetches an http(s) URL an agent picked.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createImageOperations, guardImageUris, PAID_CHECK_HINT } from "./lib/image-operations.mjs";

const annotateImages = {
  name: "annotate_images",
  title: "Annotate images (batch)",
  description: "Vision's images:annotate for up to 16 images: responses[i] belongs to requests[i] and may hold its own error",
  method: "POST",
  path: "/v1/images:annotate",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  params: {
    requests: {
      in: "body",
      type: "array",
      items: { type: "object" },
      required: true,
      maxItems: 16,
      description: 'Each {"image":{"content":"<base64>"} or {"source":{"imageUri":"gs://..."}} (agents: no http(s) imageUri),"features":[{"type":"LABEL_DETECTION","maxResults":5}]}',
    },
  },
};

const annotateFiles = {
  name: "annotate_files",
  title: "Annotate PDF/TIFF files",
  description: "OCR up to 5 pages of one inline PDF, TIFF or GIF: responses[0].responses[page]",
  method: "POST",
  path: "/v1/files:annotate",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  params: {
    requests: {
      in: "body",
      type: "array",
      items: { type: "object" },
      required: true,
      maxItems: 1,
      description: 'One request (Vision takes a single file per call): {"inputConfig":{"content":"<base64>","mimeType":"application/pdf"},"features":[{"type":"DOCUMENT_TEXT_DETECTION"}],"pages":[1,2]}',
    },
  },
};

const restDefinition = defineRestPlugin({
  name: "google-vision",
  version: "0.1.0",
  description: "Google Cloud Vision with an API key: OCR, labels, faces, safe search, logos, landmarks and objects in images",
  apiName: "Cloud Vision API",
  baseUrl: "https://vision.googleapis.com",
  auth: { type: "header", header: "x-goog-api-key", env: "GOOGLE_VISION_API_KEY" },
  // Google errors: {"error": {"code", "message", "status", "details": [{"reason": "API_KEY_INVALID"}]}}; an invalid key
  // is a 400, so the ErrorInfo reason decides the kind.
  errors: {
    messagePath: "error.message",
    codePath: "error.details.0.reason",
    kindByCode: {
      API_KEY_INVALID: "auth_error",
      API_KEY_EXPIRED: "auth_error",
      API_KEY_SERVICE_BLOCKED: "permission_denied",
      SERVICE_DISABLED: "permission_denied",
      BILLING_DISABLED: "permission_denied",
      RATE_LIMIT_EXCEEDED: "rate_limited",
    },
  },
  apiRequest: false,
  operations: [annotateImages, annotateFiles],
});

export const pluginDefinition = {
  ...restDefinition,
  extraEnv: [...restDefinition.extraEnv, "GOOGLE_VISION_UPLOAD_DIR"],
  operations: [...createImageOperations(), ...restDefinition.operations.map((operation) => (operation.name === "annotate_images" ? guardImageUris(operation) : operation))],
};
