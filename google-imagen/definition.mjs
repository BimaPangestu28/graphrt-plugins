/**
 * google-imagen plugin definition: Google image generation through the Gemini API.
 *
 * Imagen (`models/{imagen}:predict`) is shut down in the Gemini API; Google's replacement is native image output
 * of the Gemini image models ("Nano Banana": gemini-nano-banana-2.1, gemini-3.1-flash-image, gemini-3-pro-image,
 * ...) through the Interactions API (https://aistudio.google.com/api-reference/interactions-api), which Google
 * recommends over the legacy generateContent. Generated images come back base64-encoded in
 * `steps[].content[].data` and are saved into $GOOGLE_IMAGEN_OUTPUT_DIR (the blob is replaced by its path).
 *
 * Built with the declarative REST layer (docs/declarative-plugins.md); `edit_image` is hand-written
 * (lib/edit-image.mjs) because it has to read local or https images and inline them as base64 blocks.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { createEditImageOperation } from "./lib/edit-image.mjs";

const OUTPUT_DIR_ENV = "GOOGLE_IMAGEN_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "GOOGLE_IMAGEN_UPLOAD_DIR";
const DEFAULT_MODEL = "gemini-nano-banana-2.1";
const INTERACTIONS_API_REVISION = "2026-05-20";
const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:4", "4:1", "1:8", "8:1"];
const IMAGE_SIZES = ["512", "1K", "2K", "4K"];
const GENERATION_TIMEOUT_MS = 180000;
// 300 s host timeout - 15 s job margin - 180 s generation = 105 s for edit_image to read its input images.
const LIMITS = { timeout_ms: 300000 };

// Final images are in model_output steps' content blocks; interim "thought images" of thinking models are in thought
// steps' summary blocks (https://aistudio.google.com/docs/image-generation). Both are saved, so no base64 stays.
const saveImages = { saveTo: { base64Paths: ["steps[].content[].data", "steps[].summary[].data"], envDir: OUTPUT_DIR_ENV, maxFiles: 10, maxBytes: 50 * 1024 * 1024 } };
const interactionHeaders = { "Api-Revision": INTERACTIONS_API_REVISION };

const modelParam = { in: "body", type: "string", default: DEFAULT_MODEL, description: "Image model, e.g. gemini-nano-banana-2.1 (default), gemini-3.1-flash-image, gemini-3.1-flash-lite-image, gemini-3-pro-image" };
const previousInteraction = { in: "body", type: "string", description: "Continue a previous interaction (multi-turn editing of its image) by its id" };

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List Gemini API models available to the key (image models have image in their name)",
  path: "/v1beta/models",
  response: { dataPath: "models", cursorPath: "nextPageToken", cursorParam: "pageToken", limitParam: "pageSize", maxLimit: 1000 },
};

const getModel = {
  name: "get_model",
  title: "Get model",
  description: "Metadata of one model: version, token limits, supported actions",
  path: "/v1beta/models/{model}",
  params: { model: { in: "path", type: "string", required: true, description: "Model id without the models/ prefix, e.g. gemini-nano-banana-2.1" } },
};

const generateImage = {
  name: "generate_image",
  title: "Generate image",
  description: `Generate an image from a prompt with a Gemini image model (paid, SynthID-watermarked). Saved to $${OUTPUT_DIR_ENV}; pass previous_interaction_id to edit the image of an earlier call`,
  method: "POST",
  path: "/v1beta/interactions",
  write: "unsafe",
  checkHint: "generated images are not listed; check the output directory before retrying",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    prompt: { in: "body", type: "string", required: true, minLength: 1, wireName: "input", description: "What to generate, or the change to make to the previous interaction's image" },
    model: modelParam,
    aspect_ratio: { in: "body", type: "string", enum: ASPECT_RATIOS, wireName: "response_format.aspect_ratio", description: "Output aspect ratio (1:4, 4:1, 1:8, 8:1 only on Nano Banana 2.1 and 3.1 Flash)" },
    image_size: { in: "body", type: "string", enum: IMAGE_SIZES, wireName: "response_format.image_size", description: "Output size (512 only on 3.1 Flash Image); larger costs more" },
    previous_interaction_id: previousInteraction,
  },
  constants: { headers: interactionHeaders, body: { "response_format.type": "image" } },
  download: saveImages,
};

const createInteraction = {
  name: "create_interaction",
  title: "Create interaction",
  description: `Low-level Interactions API call with content blocks (text, base64 or URI images) for image generation or editing (paid). Generated images are saved to $${OUTPUT_DIR_ENV}`,
  method: "POST",
  path: "/v1beta/interactions",
  write: "unsafe",
  checkHint: "generated images are not listed; check the output directory before retrying",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    input: {
      in: "body",
      type: "array",
      required: true,
      maxItems: 20,
      items: { type: "object" },
      description: 'Content blocks, e.g. [{"type": "text", "text": "Add a hat"}, {"type": "image", "mime_type": "image/png", "data": "<base64>"}]',
    },
    model: modelParam,
    response_format: { in: "body", type: "object", description: 'e.g. {"type": "image", "aspect_ratio": "16:9", "image_size": "2K"}' },
    previous_interaction_id: previousInteraction,
  },
  constants: { headers: interactionHeaders },
  download: saveImages,
};

const getInteraction = {
  name: "get_interaction",
  title: "Get interaction",
  description: `A stored interaction with its steps; images in it are saved to $${OUTPUT_DIR_ENV}`,
  path: "/v1beta/interactions/{interaction_id}",
  params: { interaction_id: { in: "path", type: "string", required: true, description: "Interaction id from generate_image" } },
  constants: { headers: interactionHeaders },
  download: saveImages,
};

const deleteInteraction = {
  name: "delete_interaction",
  title: "Delete interaction",
  description: "Delete a stored interaction permanently",
  method: "DELETE",
  path: "/v1beta/interactions/{interaction_id}",
  write: "unsafe",
  nodeOnly: true,
  params: { interaction_id: { in: "path", type: "string", required: true, description: "Interaction id" } },
  constants: { headers: interactionHeaders },
};

const restDefinition = defineRestPlugin({
  name: "google-imagen",
  version: "0.1.0",
  description: "Google image generation via the Gemini API (Nano Banana models; Imagen is shut down): generate and edit images, saved to a local folder (paid per image)",
  apiName: "Gemini API",
  baseUrl: "https://generativelanguage.googleapis.com",
  auth: { type: "header", header: "x-goog-api-key", env: "GEMINI_API_KEY" },
  extraEnv: [UPLOAD_DIR_ENV],
  limits: LIMITS,
  // Classic Google errors: {"error": {"code": 400, "message", "status", "details": [{"reason": "API_KEY_INVALID"}]}};
  // Interactions errors: {"error": {"code": "invalid_request", "message"}}, sometimes wrapped in an array.
  errors: {
    messagePath: ["error.message", "0.error.message"],
    codePath: "error.details.0.reason",
    kindByCode: { API_KEY_INVALID: "auth_error", API_KEY_EXPIRED: "auth_error", API_KEY_SERVICE_BLOCKED: "permission_denied", SERVICE_DISABLED: "permission_denied" },
    kindByStatus: { 402: "permission_denied" },
  },
  // Generated images are base64 (MBs); tools get a preview, nodes everything.
  toolOutput: { maxChars: 20000 },
  apiRequest: { examplePath: "/v1beta/models" },
  operations: [listModels, getModel, generateImage, createInteraction, getInteraction, deleteInteraction],
});

const createInteractionOperation = restDefinition.operations.find((operation) => operation.name === "create_interaction");

const editImageOperation = createEditImageOperation({
  createInteractionOperation,
  uploadDirEnv: UPLOAD_DIR_ENV,
  defaultModel: DEFAULT_MODEL,
  aspectRatios: ASPECT_RATIOS,
  imageSizes: IMAGE_SIZES,
  limits: LIMITS,
  generationTimeoutMs: GENERATION_TIMEOUT_MS,
});

// list_models returns names as "models/<id>"; accept that form in get_model too.
const stripModelsPrefix = (operation) => ({
  ...operation,
  run: (context) => operation.run({ ...context, args: { ...context.args, model: String(context.args.model).replace(/^models\//, "") } }),
});

export const pluginDefinition = {
  ...restDefinition,
  operations: [...restDefinition.operations.map((operation) => (operation.name === getModel.name ? stripModelsPrefix(operation) : operation)), editImageOperation],
};
