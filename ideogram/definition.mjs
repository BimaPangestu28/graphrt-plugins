/**
 * ideogram plugin definition: Ideogram API v2 (https://developer.ideogram.ai/v2/ideogram-api/api-overview) built
 * with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Every v2 image endpoint is `POST /v2/image/{action}/{model}` with multipart/form-data and answers synchronously
 * with `data[].url` (links expire), which are downloaded into $IDEOGRAM_OUTPUT_DIR. Every paid endpoint accepts
 * `dry_run=true`, which validates and prices the request without generating or billing anything. Async mode and
 * webhooks are not exposed: calls wait for the images.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { withFilteredImageReport } from "./lib/filtered-images.mjs";

const OUTPUT_DIR_ENV = "IDEOGRAM_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "IDEOGRAM_UPLOAD_DIR";
const REQUEST_TIMEOUT_MS = 240000;

const saveImages = { saveTo: { urlPaths: ["data[].url"], envDir: OUTPUT_DIR_ENV, maxFiles: 10 } };

const body = (type, description, extra = {}) => ({ in: "body", type, description, ...extra });
const imageFile = (description, required = true) => ({ in: "body", type: "string", file: true, required, description });
const promptParam = (description) => body("string", description, { required: true, minLength: 1 });
const seed = body("integer", "Random seed for reproducible results", { min: 0 });
const numImages = body("integer", "Number of images (default 1); each image is billed", { min: 1, max: 8 });
const copyrightDetection = body("boolean", "Run likeness and logo checks; flagged images come back with is_image_safe false (adds latency)");
const dryRun = { in: "query", type: "boolean", description: "true: validate and price the request without generating or billing (returns a price quote)" };

/** Ideogram 3.0 style controls (values as in the Ideogram docs; casing is passed through unchanged). */
const v3StyleParams = {
  rendering_speed: body("string", "Speed/quality tier, e.g. TURBO, DEFAULT or QUALITY (priced differently)"),
  magic_prompt: body("string", "Automatic prompt rewriting, e.g. AUTO (default), ON or OFF"),
  style_type: body("string", "e.g. AUTO, GENERAL, REALISTIC, DESIGN, FICTION"),
  style_preset: body("string", "A predefined style preset name (cannot be combined with style_codes)"),
  style_codes: body("array", "8-character hex style codes", { items: { type: "string" }, maxItems: 10 }),
  style_reference_image: { ...imageFile("Optional style reference image", false), wireName: "style_reference_images" },
};

/**
 * Builds a paid, synchronous Ideogram image operation whose result URLs are downloaded.
 *
 * @param operation - `{name, title, description, path, params}` (object)
 * @returns Operation spec (object)
 */
function imageOperation(operation) {
  return {
    ...operation,
    description: `${operation.description}. Images are saved to $${OUTPUT_DIR_ENV}`,
    method: "POST",
    write: "unsafe",
    checkHint: "get_usage shows what was billed; check before retrying",
    bodyMode: "multipart",
    multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: 50 * 1024 * 1024 },
    timeoutMs: REQUEST_TIMEOUT_MS,
    params: { dry_run: dryRun, ...operation.params },
    download: saveImages,
  };
}

const generateImage = imageOperation({
  name: "generate_image",
  title: "Generate image (Ideogram 4.5)",
  description: "Generate images with Ideogram 4.5 (strong typography and prompt fidelity), or edit a source image by prompt ($0.03-0.22 per image by quality)",
  path: "/v2/image/generate/ideogram-4-5",
  params: {
    prompt: promptParam("What to generate, or the edit instruction when an image is given (natural language or an Ideogram JSON prompt)"),
    image: { ...imageFile("Optional source image to edit (the first of `images`)", false), wireName: "images" },
    mask: imageFile("Optional mask for the source image: black = edit, white = keep (same size as the image)", false),
    size: body("string", 'auto (default), "source" (with an image) or WIDTHxHEIGHT from the supported 1K/2K presets, e.g. 1024x1024, 2048x2048'),
    quality: body("string", "very_low (with a source image only), low, medium or high (default high without, medium with a source image); priced by quality"),
    background: body("string", "Output background", { enum: ["auto", "transparent", "opaque"] }),
    magic_prompt: body("string", "Prompt rewriting: auto (default), on or off", { enum: ["auto", "on", "off"] }),
    seed,
    num_images: numImages,
    enable_copyright_detection: copyrightDetection,
  },
});

const generateImageV3 = imageOperation({
  name: "generate_image_v3",
  title: "Generate image (Ideogram 3.0)",
  description: "Generate images with Ideogram 3.0, with style types, presets, style codes and a style reference ($0.03 turbo, $0.06 default, $0.09 quality per image)",
  path: "/v2/image/generate/ideogram-3",
  params: {
    prompt: promptParam("What to generate"),
    negative_prompt: body("string", "What to leave out (the prompt takes precedence)"),
    aspect_ratio: body("string", "e.g. 1x1, 16x9, 9x16, 4x3 (do not combine with resolution)"),
    resolution: body("string", "Exact resolution, e.g. 1024x1024 or 1280x768"),
    ...v3StyleParams,
    seed,
    num_images: numImages,
    enable_copyright_detection: copyrightDetection,
  },
});

const remixImage = imageOperation({
  name: "remix_image",
  title: "Remix image (Ideogram 3.0)",
  description: "Transform an image with a prompt (Ideogram 3.0, billed at the 3.0 generation rate)",
  path: "/v2/image/remix/ideogram-3",
  params: {
    prompt: promptParam("How to transform the image"),
    image: imageFile("Image to transform (max 50 MB; saved to your account as the remix source)"),
    image_weight: body("integer", "How closely to follow the source, 1-100 (default chosen from the prompt)", { min: 1, max: 100 }),
    negative_prompt: body("string", "What to leave out"),
    aspect_ratio: body("string", "e.g. 1x1, 16x9 (omit to keep the source shape)"),
    resolution: body("string", "Exact resolution (omit to keep the source shape)"),
    ...v3StyleParams,
    seed,
    num_images: numImages,
    enable_copyright_detection: copyrightDetection,
  },
});

const preciseEdit = imageOperation({
  name: "precise_edit",
  title: "Precise edit (Ideogram 4.5)",
  description: "Change only what the prompt says and copy every other pixel exactly, optionally limited by a mask ($0.008-0.22 per image by quality)",
  path: "/v2/image/precise-edit/ideogram-4-5",
  params: {
    prompt: promptParam("The edit instruction, e.g. Change the jacket to red leather. Keep everything else the same."),
    image: imageFile("Image to edit (max 50 MB; output keeps its size)"),
    mask: imageFile("Optional mask: black = edit, white = keep", false),
    reference_image: { ...imageFile("Optional reference image (product, material, style) to guide the edit", false), wireName: "reference_images" },
    quality: body("string", "very_low, low, medium or high (the only price factor)"),
    context_window: body("string", "Region to edit for images over 4.2 megapixels, e.g. none (whole image)"),
    seed,
    num_images: numImages,
    enable_copyright_detection: copyrightDetection,
  },
});

const inpaintImage = imageOperation({
  name: "inpaint_image",
  title: "Inpaint (Ideogram 3.0)",
  description: "Repaint the black area of a mask with new content (Ideogram 3.0, billed at the 3.0 generation rate)",
  path: "/v2/image/inpaint/ideogram-3",
  params: {
    prompt: promptParam("What the repainted area should show"),
    image: imageFile("Source image (max 25 MB)"),
    mask: imageFile("Black-and-white mask of the same size; black marks the region to repaint"),
    rendering_speed: v3StyleParams.rendering_speed,
    magic_prompt: v3StyleParams.magic_prompt,
    style_type: v3StyleParams.style_type,
    style_preset: v3StyleParams.style_preset,
    style_codes: v3StyleParams.style_codes,
    seed,
    num_images: numImages,
    enable_copyright_detection: copyrightDetection,
  },
});

const reframeImage = imageOperation({
  name: "reframe_image",
  title: "Reframe (Ideogram 3.0)",
  description: "Extend an image to a new resolution/aspect ratio, filling the new area (billed at the 3.0 generation rate)",
  path: "/v2/image/reframe/ideogram-3",
  params: {
    image: imageFile("Image to reframe (max 25 MB)"),
    resolution: body("string", "Target resolution, e.g. 1536x640 or 1024x1024", { required: true, minLength: 1 }),
    rendering_speed: v3StyleParams.rendering_speed,
    style_preset: v3StyleParams.style_preset,
    seed,
    num_images: numImages,
  },
});

const upscaleImage = imageOperation({
  name: "upscale_image",
  title: "Upscale image",
  description: "Upscale an image 2x, 4x or 8x with the model Ideogram picks (priced by the chosen model; use dry_run for a quote)",
  path: "/v2/image/upscale/auto",
  params: {
    image: imageFile("Image to upscale (max 50 MB; not stored)"),
    upscale_factor: body("string", "2x, 4x or 8x (output at most 8192 px per side)"),
    seed,
  },
});

const removeBackground = imageOperation({
  name: "remove_background",
  title: "Remove background",
  description: "Cut out the foreground with a transparent background ($0.01)",
  path: "/v2/image/remove-background/ideogram-1",
  params: {
    image: imageFile("Source image (max 25 MB)"),
    private: body("boolean", "Keep the result out of Ideogram's public gallery (default: your plan's setting)"),
  },
});

const describeImage = {
  name: "describe_image",
  title: "Describe image (Ideogram 4.0)",
  description: "Turn an image into a structured Ideogram 4.0 JSON prompt (subjects, text, layout) to regenerate or edit it ($0.01)",
  method: "POST",
  path: "/v2/image/describe/ideogram-4",
  write: "unsafe",
  checkHint: "describing again only costs another $0.01",
  bodyMode: "multipart",
  multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: 10 * 1024 * 1024 },
  params: {
    image: imageFile("Image to describe (max 10 MB)"),
    include_bbox: body("boolean", "Include bounding boxes (default true)"),
    include_style_descriptions: body("boolean", "Include a free-form style description (default false)"),
    include_tags: body("boolean", "Include free-form tags (default false)"),
  },
};

const getGeneration = {
  name: "get_generation",
  title: "Get generation",
  description: `Status (pending, completed, failed) and images of a generation by generation_id; completed image URLs are saved to $${OUTPUT_DIR_ENV}`,
  path: "/v2/generations/{generation_id}",
  params: { generation_id: { in: "path", type: "string", required: true, description: "generation_id from an earlier response" } },
  download: saveImages,
};

const getUsage = {
  name: "get_usage",
  title: "Get usage and spend",
  description: "Usage and spend of the API account in daily or hourly buckets",
  path: "/v2/account/usage",
  params: {
    start_time: { in: "query", type: "string", required: true, description: "Start of the range, RFC 3339, e.g. 2026-11-01T00:00:00Z" },
    end_time: { in: "query", type: "string", description: "End of the range (exclusive, default now)" },
    bucket_width: { in: "query", type: "string", enum: ["1d", "1h"], description: "1d (up to 92 days, default) or 1h (up to 168 hours)" },
    sources: { in: "query", type: "array", items: { type: "string", enum: ["api", "app"] }, style: "repeat", description: "api and/or app usage (default both)" },
  },
  response: { dataPath: "buckets" },
};

const restDefinition = defineRestPlugin({
  name: "ideogram",
  version: "0.1.0",
  description: "Ideogram: generate (4.5 and 3.0), remix, precise edit, inpaint, reframe, upscale, remove background and describe images, saved to a local folder (paid per image)",
  apiName: "Ideogram API",
  baseUrl: "https://api.ideogram.ai",
  auth: { type: "header", header: "Api-Key", env: "IDEOGRAM_API_KEY" },
  limits: { timeout_ms: 300000 },
  // 402/429 bodies: {"error": "...", "reject_reason": "insufficient_funds" | "daily_limit" | ...}; remove-background
  // can answer 200 with {"error", "status_code"} when it fails after streaming started.
  errors: {
    messagePath: ["error", "detail", "message"],
    codePath: "reject_reason",
    kindByCode: { insufficient_funds: "permission_denied", subscription_required: "permission_denied", daily_limit: "rate_limited", inflight_limit: "rate_limited" },
    kindByStatus: { 402: "permission_denied", 422: "invalid_input" },
    errorPath: "error",
  },
  apiRequest: { examplePath: "/v2/account/usage?start_time=2026-11-01T00:00:00Z" },
  operations: [generateImage, generateImageV3, remixImage, preciseEdit, inpaintImage, reframeImage, upscaleImage, removeBackground, describeImage, getGeneration, getUsage],
});

// Every operation that downloads data[].url reports safety-filtered images (empty url) as `filtered: true`.
const imageDownloadOperations = new Set(restDefinition.restSpec.operations.filter((operation) => operation.download).map((operation) => operation.name));

export const pluginDefinition = {
  ...restDefinition,
  operations: restDefinition.operations.map((operation) => (imageDownloadOperations.has(operation.name) ? withFilteredImageReport(operation) : operation)),
};
