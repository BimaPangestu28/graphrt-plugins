/**
 * stability-ai plugin definition: Stability AI Stable Image REST API v2beta (https://docs.stability.ai/api-reference)
 * built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Every Stable Image endpoint takes multipart/form-data. The synchronous ones are called with `Accept: image/*`
 * and their binary body is streamed into $STABILITY_AI_OUTPUT_DIR (required for them). Creative Upscale is
 * asynchronous: it returns an id, and /v2beta/results/{id} answers 202 while running and 200 with the base64 image
 * (Accept: application/json) when done; the image is saved to the same directory. Every successful call costs
 * credits (1 credit = $0.01; failed results are free).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const OUTPUT_DIR_ENV = "STABILITY_AI_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "STABILITY_AI_UPLOAD_DIR";
const MAX_RESULT_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180000;
const STYLE_PRESETS = ["enhance", "anime", "photographic", "digital-art", "comic-book", "fantasy-art", "line-art", "analog-film", "neon-punk", "isometric", "low-poly", "origami", "modeling-compound", "cinematic", "3d-model", "pixel-art", "tile-texture"];
const ASPECT_RATIOS = ["21:9", "16:9", "3:2", "5:4", "1:1", "4:5", "2:3", "9:16", "9:21"];

// --- shared params ---------------------------------------------------------------------------------

const body = (type, description, extra = {}) => ({ in: "body", type, description, ...extra });
const imageFile = (description, required = true) => ({ in: "body", type: "string", file: true, required, description });
const prompt = (description = "What you wish to see in the output image (max 10000 characters)") => body("string", description, { required: true, minLength: 1 });
const negativePrompt = body("string", "What you do not wish to see in the output image");
const seed = body("integer", "Randomness seed, 0 for random (0-4294967294)", { min: 0, max: 4294967294 });
const stylePreset = body("string", "Guide the image towards a style", { enum: STYLE_PRESETS });
const aspectRatio = body("string", "Aspect ratio of the output (default 1:1)", { enum: ASPECT_RATIOS });
const outputFormat = (formats = ["png", "jpeg", "webp"]) => body("string", `Output format (default ${formats[0]})`, { enum: formats });
const growMask = (max, defaultValue) => body("number", `Grow the mask edges by this many pixels to smooth the transition (0-${max}, default ${defaultValue})`, { min: 0, max });
const controlStrength = body("number", "How much the input image influences the result, 0-1 (default 0.7)", { min: 0, max: 1 });

/**
 * Builds a synchronous Stable Image operation: multipart in, the image bytes saved to $STABILITY_AI_OUTPUT_DIR.
 *
 * @param operation - `{name, title, description, path, params, credits}` (object)
 * @returns Operation spec (object)
 */
function imageOperation({ credits, ...operation }) {
  return {
    ...operation,
    description: `${operation.description} (${credits} credits). Saved to $${OUTPUT_DIR_ENV}; returns {path, bytes, content_type}`,
    method: "POST",
    write: "unsafe",
    checkHint: "check the credit balance (get_balance) and the output directory before retrying",
    bodyMode: "multipart",
    multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: 25 * 1024 * 1024 },
    constants: { headers: { accept: "image/*" } },
    timeoutMs: REQUEST_TIMEOUT_MS,
    response: { binary: { envDir: OUTPUT_DIR_ENV, maxBytes: MAX_RESULT_BYTES } },
  };
}

// --- account ---------------------------------------------------------------------------------------

const getAccount = { name: "get_account", title: "Get account", description: "The account (email, id, organizations) that owns the API key", path: "/v1/user/account" };
const getBalance = { name: "get_balance", title: "Get credit balance", description: "Credit balance of the key's account or organization (1 credit = $0.01)", path: "/v1/user/balance" };

// --- generate --------------------------------------------------------------------------------------

const generateUltra = imageOperation({
  name: "generate_ultra",
  title: "Generate image (Stable Image Ultra)",
  description: "Highest-quality text-to-image (about 1 megapixel), optionally guided by an input image",
  credits: 8,
  path: "/v2beta/stable-image/generate/ultra",
  params: { prompt: prompt(), negative_prompt: negativePrompt, aspect_ratio: aspectRatio, seed, output_format: outputFormat(), style_preset: stylePreset, image: imageFile("Optional starting image", false), strength: body("number", "Influence of image, 0 (keep) to 1 (ignore); required with image", { min: 0, max: 1 }) },
});

const generateCore = imageOperation({
  name: "generate_core",
  title: "Generate image (Stable Image Core)",
  description: "Fast, low-cost text-to-image",
  credits: 3,
  path: "/v2beta/stable-image/generate/core",
  params: { prompt: prompt(), negative_prompt: negativePrompt, aspect_ratio: aspectRatio, seed, style_preset: stylePreset, output_format: outputFormat() },
});

const generateSd3 = imageOperation({
  name: "generate_sd3",
  title: "Generate image (Stable Diffusion 3.5)",
  description: "Text-to-image or image-to-image with Stable Diffusion 3.5 Large (6.5 credits), Large Turbo (4) or Medium (3.5)",
  credits: "3.5-6.5",
  path: "/v2beta/stable-image/generate/sd3",
  params: {
    prompt: prompt(),
    model: body("string", "Model (default sd3.5-large)", { enum: ["sd3.5-large", "sd3.5-large-turbo", "sd3.5-medium"] }),
    mode: body("string", "text-to-image (default) or image-to-image (needs image and strength)", { enum: ["text-to-image", "image-to-image"] }),
    image: imageFile("Starting image for image-to-image", false),
    strength: body("number", "Influence of image, 0-1 (image-to-image)", { min: 0, max: 1 }),
    aspect_ratio: aspectRatio,
    negative_prompt: negativePrompt,
    cfg_scale: body("number", "How strictly to follow the prompt, 1-10", { min: 1, max: 10 }),
    seed,
    style_preset: stylePreset,
    output_format: outputFormat(),
  },
});

// --- upscale ---------------------------------------------------------------------------------------

const upscaleFast = imageOperation({
  name: "upscale_fast",
  title: "Upscale image (fast)",
  description: "Upscale an image 4x in about a second (output up to 4 megapixels)",
  credits: 2,
  path: "/v2beta/stable-image/upscale/fast",
  params: { image: imageFile("Image to upscale (32-1536 px per side)"), output_format: outputFormat() },
});

const upscaleConservative = imageOperation({
  name: "upscale_conservative",
  title: "Upscale image (conservative)",
  description: "Upscale an image (64x64 to 1 megapixel) to 4 megapixels with minimal changes",
  credits: 40,
  path: "/v2beta/stable-image/upscale/conservative",
  params: { image: imageFile("Image to upscale"), prompt: prompt("Describes the image, to guide the upscale"), negative_prompt: negativePrompt, creativity: body("number", "How much detail to invent, 0.2-0.5 (default 0.35)", { min: 0.2, max: 0.5 }), seed, output_format: outputFormat() },
});

const upscaleCreative = {
  name: "upscale_creative",
  title: "Upscale image (creative, async)",
  description: `Re-imagine and upscale a degraded image (under 1 megapixel) to up to 4K, waiting for the async job (60 credits). The image is saved to $${OUTPUT_DIR_ENV}`,
  method: "POST",
  path: "/v2beta/stable-image/upscale/creative",
  write: "unsafe",
  checkHint: "check the credit balance (get_balance) before retrying",
  bodyMode: "multipart",
  multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: 25 * 1024 * 1024 },
  timeoutMs: REQUEST_TIMEOUT_MS,
  params: {
    image: imageFile("Image to upscale (64x64 to 1 megapixel)"),
    prompt: prompt("Describes the image, to guide the upscale"),
    negative_prompt: negativePrompt,
    creativity: body("number", "How much detail to invent, 0.1-0.5 (default 0.3)", { min: 0.1, max: 0.5 }),
    style_preset: stylePreset,
    seed,
    output_format: outputFormat(),
  },
  // The results endpoint answers 202 {id, status: "in-progress"} while running and 200 {image, seed, finish_reason}.
  job: { idPath: "id", poll: { path: "/v2beta/results/{id}" }, statusPath: "finish_reason", doneValues: ["SUCCESS", "CONTENT_FILTERED"], resultPath: "image", intervalMs: 5000, timeoutMs: 300000 },
  download: { saveTo: { base64Paths: [""], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_RESULT_BYTES, maxFiles: 1 } },
};

const getResult = {
  name: "get_result",
  title: "Get async result",
  description: `Fetch an async generation by id (results are kept 24 hours): {id, status: "in-progress"} while running, else the image saved to $${OUTPUT_DIR_ENV} with seed and finish_reason`,
  path: "/v2beta/results/{generation_id}",
  params: { generation_id: { in: "path", type: "string", required: true, description: "The 64-character id returned by an async operation" } },
  download: { saveTo: { base64Paths: ["image"], envDir: OUTPUT_DIR_ENV, maxBytes: MAX_RESULT_BYTES, maxFiles: 1 } },
};

// --- edit ------------------------------------------------------------------------------------------

const erase = imageOperation({
  name: "erase_object",
  title: "Erase object",
  description: "Remove unwanted objects marked by a mask (or the image's alpha channel)",
  credits: 5,
  path: "/v2beta/stable-image/edit/erase",
  params: { image: imageFile("Image to edit"), mask: imageFile("Mask: white marks what to erase (else the image's alpha channel is used)", false), grow_mask: growMask(20, 5), seed, output_format: outputFormat() },
});

const inpaint = imageOperation({
  name: "inpaint",
  title: "Inpaint",
  description: "Fill or replace the masked area (or transparent area) of an image with new content from a prompt",
  credits: 5,
  path: "/v2beta/stable-image/edit/inpaint",
  params: { image: imageFile("Image to edit"), prompt: prompt(), mask: imageFile("Mask: white marks the area to repaint (else the image's alpha channel is used)", false), negative_prompt: negativePrompt, grow_mask: growMask(100, 5), seed, style_preset: stylePreset, output_format: outputFormat() },
});

const outpaint = imageOperation({
  name: "outpaint",
  title: "Outpaint",
  description: "Extend an image in any direction (left/right/up/down pixels, at least one)",
  credits: 4,
  path: "/v2beta/stable-image/edit/outpaint",
  params: {
    image: imageFile("Image to extend"),
    left: body("integer", "Pixels to add on the left (0-2000)", { min: 0, max: 2000 }),
    right: body("integer", "Pixels to add on the right (0-2000)", { min: 0, max: 2000 }),
    up: body("integer", "Pixels to add at the top (0-2000)", { min: 0, max: 2000 }),
    down: body("integer", "Pixels to add at the bottom (0-2000)", { min: 0, max: 2000 }),
    creativity: body("number", "How creative the new content is, 0-1 (default 0.5)", { min: 0, max: 1 }),
    prompt: body("string", "Optional description of the new content"),
    seed,
    style_preset: stylePreset,
    output_format: outputFormat(),
  },
});

const searchAndReplace = imageOperation({
  name: "search_and_replace",
  title: "Search and replace",
  description: "Find an object by a short description and replace it with the prompt, no mask needed",
  credits: 5,
  path: "/v2beta/stable-image/edit/search-and-replace",
  params: { image: imageFile("Image to edit"), prompt: prompt("What to put in place of the found object"), search_prompt: body("string", "Short description of the object to replace, e.g. glasses", { required: true, minLength: 1 }), negative_prompt: negativePrompt, grow_mask: growMask(20, 3), seed, style_preset: stylePreset, output_format: outputFormat() },
});

const searchAndRecolor = imageOperation({
  name: "search_and_recolor",
  title: "Search and recolor",
  description: "Find an object by a short description and recolor it as the prompt says, no mask needed",
  credits: 5,
  path: "/v2beta/stable-image/edit/search-and-recolor",
  params: { image: imageFile("Image to edit"), prompt: prompt("The new colors, e.g. a red leather jacket"), select_prompt: body("string", "Short description of the object to recolor, e.g. jacket", { required: true, minLength: 1 }), negative_prompt: negativePrompt, grow_mask: growMask(20, 3), seed, style_preset: stylePreset, output_format: outputFormat() },
});

const removeBackground = imageOperation({
  name: "remove_background",
  title: "Remove background",
  description: "Cut the foreground out of an image with a transparent background",
  credits: 5,
  path: "/v2beta/stable-image/edit/remove-background",
  params: { image: imageFile("Image to cut out"), output_format: outputFormat(["png", "webp"]) },
});

// --- control ---------------------------------------------------------------------------------------

const controlParams = { prompt: prompt(), image: imageFile("Control image"), control_strength: controlStrength, negative_prompt: negativePrompt, seed, style_preset: stylePreset, output_format: outputFormat() };

const controlSketch = imageOperation({
  name: "control_sketch",
  title: "Sketch to image",
  description: "Turn a sketch or line art into a finished image that follows its contours",
  credits: 5,
  path: "/v2beta/stable-image/control/sketch",
  params: controlParams,
});

const controlStructure = imageOperation({
  name: "control_structure",
  title: "Structure to image",
  description: "Generate an image that keeps the structure (layout, poses) of an input image",
  credits: 5,
  path: "/v2beta/stable-image/control/structure",
  params: controlParams,
});

const controlStyle = imageOperation({
  name: "control_style",
  title: "Style guide",
  description: "Generate an image from a prompt in the style of an input image",
  credits: 5,
  path: "/v2beta/stable-image/control/style",
  params: {
    prompt: prompt(),
    image: imageFile("Style reference image"),
    negative_prompt: negativePrompt,
    aspect_ratio: aspectRatio,
    fidelity: body("number", "How closely to follow the reference style, 0-1 (default 0.5)", { min: 0, max: 1 }),
    seed,
    style_preset: stylePreset,
    output_format: outputFormat(),
  },
});

export const pluginDefinition = defineRestPlugin({
  name: "stability-ai",
  version: "0.1.0",
  description: "Stability AI Stable Image: generate (Ultra, Core, SD 3.5), upscale, edit and control images, saved to a local folder (paid in credits)",
  apiName: "Stability AI REST API",
  baseUrl: "https://api.stability.ai",
  auth: { type: "bearer", env: "STABILITY_API_KEY" },
  limits: { timeout_ms: 360000 },
  // v2beta errors: {id, name, errors: [..]}; v1 errors: {id, name, message}.
  errors: {
    messagePath: ["errors.0", "message"],
    codePath: "name",
    kindByStatus: { 402: "permission_denied", 403: "invalid_input" },
  },
  apiRequest: { examplePath: "/v1/user/balance" },
  operations: [
    getAccount, getBalance,
    generateUltra, generateCore, generateSd3,
    upscaleFast, upscaleConservative, upscaleCreative, getResult,
    erase, inpaint, outpaint, searchAndReplace, searchAndRecolor, removeBackground,
    controlSketch, controlStructure, controlStyle,
  ],
});
