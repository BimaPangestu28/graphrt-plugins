/**
 * openai-images plugin definition: OpenAI Images API (https://developers.openai.com/api/reference/resources/images)
 * built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Generations and edits are paid calls. GPT Image models always answer with base64 (`data[].b64_json`), DALL·E
 * models can answer with temporary URLs (`data[].url`); both are saved under $OPENAI_IMAGES_OUTPUT_DIR and the
 * base64 is replaced by "[saved to <path>]" so a large blob never reaches an agent. The variations endpoint is
 * retired by OpenAI (use edit_image with a prompt instead), so it is not offered.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const OUTPUT_DIR_ENV = "OPENAI_IMAGES_OUTPUT_DIR";
const UPLOAD_DIR_ENV = "OPENAI_IMAGES_UPLOAD_DIR";
const DEFAULT_MODEL = "gpt-image-2";
const GENERATION_TIMEOUT_MS = 300000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const saveImages = { saveTo: { base64Paths: ["data[].b64_json"], urlPaths: ["data[].url"], envDir: OUTPUT_DIR_ENV, maxFiles: 10, maxBytes: 100 * 1024 * 1024 } };

/** Body params shared by generations and both edit forms. */
const imageOptions = {
  model: { in: "body", type: "string", default: DEFAULT_MODEL, description: "Model, e.g. gpt-image-2, gpt-image-1.5, gpt-image-1-mini, chatgpt-image-latest (dall-e-3 / dall-e-2 for generations only)" },
  n: { in: "body", type: "integer", min: 1, max: 10, description: "Number of images (default 1; dall-e-3 supports only 1)" },
  size: { in: "body", type: "string", description: 'auto (default), 1024x1024, 1536x1024, 1024x1536; gpt-image-2 models also take WIDTHxHEIGHT (multiples of 16, max 3840x2160)' },
  quality: { in: "body", type: "string", enum: ["auto", "low", "medium", "high", "xhigh", "max", "standard", "hd"], description: "auto (default); low/medium/high for GPT Image; xhigh/max only on 2.5 models; standard/hd for dall-e-3. Higher quality costs more" },
  background: { in: "body", type: "string", enum: ["auto", "transparent", "opaque"], description: "transparent needs output_format png or webp (GPT Image only)" },
  output_format: { in: "body", type: "string", enum: ["png", "jpeg", "webp", "gif", "svg"], description: "Output format (GPT Image only, default png)" },
  output_compression: { in: "body", type: "integer", min: 0, max: 100, description: "0-100 compression for jpeg/webp (GPT Image only)" },
  moderation: { in: "body", type: "string", enum: ["auto", "low"], description: "Content moderation level (GPT Image only, default auto)" },
  safety_identifier: { in: "body", type: "string", description: "Stable hashed id of your end user, for OpenAI abuse monitoring (max 128 characters)" },
};

const listModels = {
  name: "list_models",
  title: "List models",
  description: "List the models this API key can use (image models start with gpt-image, chatgpt-image or dall-e)",
  path: "/models",
  response: { dataPath: "data" },
};

const generateImage = {
  name: "generate_image",
  title: "Generate image",
  description: "Generate images from a text prompt (paid). Images are saved to $OPENAI_IMAGES_OUTPUT_DIR; the result lists saved_files",
  method: "POST",
  path: "/images/generations",
  write: "unsafe",
  checkHint: "image generations are not listed by the API; check your usage dashboard before retrying",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    prompt: { in: "body", type: "string", required: true, minLength: 1, description: "What to generate (max 32000 characters for GPT Image, 4000 for dall-e-3)" },
    ...imageOptions,
    style: { in: "body", type: "string", enum: ["vivid", "natural"], description: "dall-e-3 only" },
    response_format: { in: "body", type: "string", enum: ["url", "b64_json"], description: "dall-e models only (GPT Image always returns base64); URLs expire after 60 minutes" },
  },
  download: saveImages,
};

const editImage = {
  name: "edit_image",
  title: "Edit image",
  description: "Edit an image (or create a variation of it) from a prompt, optionally limited to a transparent-mask area (paid). Upload: https URL or a file inside $OPENAI_IMAGES_UPLOAD_DIR",
  method: "POST",
  path: "/images/edits",
  write: "unsafe",
  checkHint: "image edits are not listed by the API; check your usage dashboard before retrying",
  bodyMode: "multipart",
  multipart: { fileDirEnv: UPLOAD_DIR_ENV, maxFileBytes: MAX_UPLOAD_BYTES },
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    image: { in: "body", type: "string", file: true, required: true, description: "Image to edit (png, webp or jpg, under 50 MB)" },
    mask: { in: "body", type: "string", file: true, description: "PNG with the same size as image; fully transparent areas are edited" },
    prompt: { in: "body", type: "string", required: true, minLength: 1, description: "The edit to make (max 32000 characters)" },
    ...imageOptions,
    input_fidelity: { in: "body", type: "string", enum: ["low", "high"], description: "How closely to keep faces and details of the input (gpt-image-1.5; omit for gpt-image-2)" },
  },
  download: saveImages,
};

const editImageFromReferences = {
  name: "edit_image_from_references",
  title: "Edit image from references",
  description: "Edit or combine up to 16 images given as URLs, data URLs or uploaded file ids (GPT Image models, paid). The first image is the one edited",
  method: "POST",
  path: "/images/edits",
  write: "unsafe",
  checkHint: "image edits are not listed by the API; check your usage dashboard before retrying",
  timeoutMs: GENERATION_TIMEOUT_MS,
  params: {
    images: {
      in: "body",
      type: "array",
      required: true,
      maxItems: 16,
      items: { type: "object", properties: { image_url: { type: "string" }, file_id: { type: "string" } } },
      description: 'Input images, e.g. [{"image_url": "https://example.com/a.png"}, {"file_id": "file-abc"}]',
    },
    mask: { in: "body", type: "object", description: 'Optional mask for the first image: {"image_url": "..."} or {"file_id": "..."}' },
    prompt: { in: "body", type: "string", required: true, minLength: 1, description: "The edit to make (max 32000 characters)" },
    ...imageOptions,
    input_fidelity: { in: "body", type: "string", enum: ["low", "high"], description: "How closely to keep faces and details of the inputs (gpt-image-1.5; omit for gpt-image-2)" },
  },
  download: saveImages,
};

export const pluginDefinition = defineRestPlugin({
  name: "openai-images",
  version: "0.1.0",
  description: "OpenAI Images: generate and edit images with GPT Image and DALL·E models, saved to a local folder (paid)",
  apiName: "OpenAI API",
  baseUrl: "https://api.openai.com/v1",
  auth: { type: "bearer", env: "OPENAI_API_KEY" },
  limits: { timeout_ms: 360000 },
  errors: {
    messagePath: "error.message",
    codePath: "error.code",
    kindByCode: {
      invalid_api_key: "auth_error",
      insufficient_quota: "permission_denied",
      billing_hard_limit_reached: "permission_denied",
      moderation_blocked: "invalid_input",
      content_policy_violation: "invalid_input",
      model_not_found: "not_found",
    },
  },
  // Generated images can be several MB of base64; tools get a preview, nodes get everything.
  toolOutput: { maxChars: 20000 },
  apiRequest: { examplePath: "/models" },
  operations: [listModels, generateImage, editImage, editImageFromReferences],
});
