/**
 * `edit_image` for google-imagen: a hand-written operation next to the declarative ones.
 *
 * The Interactions API takes input images only inline (base64 `data`) or as Files API URIs, and the declarative
 * layer can turn files into multipart parts but not into base64 JSON fields. This operation reads each image with
 * the layer's own file-input rules (public https URL, or an absolute path inside the upload allowlist directory,
 * realpath-checked, regular files only, size-capped), checks it is an image, builds
 * `[{type: "text"}, {type: "image", mime_type, data}...]` and delegates to the declarative `create_interaction`,
 * so the request, error mapping, unknown-outcome handling, downloads and tool truncation are the layer's.
 *
 * Time budget: the host gives the call `limits.timeout_ms`; the layer keeps 15 s of it as a margin and
 * create_interaction may take `generationTimeoutMs`. Reading the inputs gets what is left, through an abort
 * signal, and the generation is not started when reading ran past that (it could not finish in time).
 *
 * Size: inline data limits the whole request (prompt and base64 bytes) to 20 MB
 * (https://aistudio.google.com/docs/image-understanding#inline-image), so the base64 size is checked against it.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { readFileInput, sniffMediaType } from "./shared/rest-files.mjs";
import { describeTimeBudgets } from "./shared/rest-spec-helpers.mjs";

export const MAX_INPUT_IMAGES = 14;
export const MAX_INLINE_REQUEST_BYTES = 20 * 1000 * 1000;
// Room for the JSON envelope, model name and response format around the prompt and images.
const REQUEST_ENVELOPE_BYTES = 16 * 1024;
// Largest raw image whose base64 still fits the inline request limit.
export const MAX_IMAGE_BYTES = Math.floor(((MAX_INLINE_REQUEST_BYTES - REQUEST_ENVELOPE_BYTES) * 3) / 4);
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/gif", "image/bmp", "image/tiff"]);

/**
 * Builds the `edit_image` operation.
 *
 * @param options - Settings (object)
 * @param options.createInteractionOperation - The generated `create_interaction` operation (object with run)
 * @param options.uploadDirEnv - Env var naming the local upload allowlist directory (string)
 * @param options.defaultModel - Default image model id (string)
 * @param options.aspectRatios - Allowed aspect ratios (string[])
 * @param options.imageSizes - Allowed image sizes (string[])
 * @param options.limits - The plugin's `limits` (object)
 * @param options.generationTimeoutMs - create_interaction's request timeout (number)
 * @returns Operation `{name, title, description, parameters, run}` (object)
 * @throws Error - When the limits leave no time to read inputs
 *
 * @example
 * createEditImageOperation({ createInteractionOperation, uploadDirEnv: "GOOGLE_IMAGEN_UPLOAD_DIR",
 *   defaultModel: "gemini-nano-banana-2.1", aspectRatios: ["1:1"], imageSizes: ["1K"],
 *   limits: { timeout_ms: 300000 }, generationTimeoutMs: 180000 });
 */
export function createEditImageOperation({ createInteractionOperation, uploadDirEnv, defaultModel, aspectRatios, imageSizes, limits, generationTimeoutMs }) {
  const readBudgetMs = describeTimeBudgets(limits).jobBudgetCapMs - generationTimeoutMs;
  if (!(readBudgetMs > 0)) throw new Error("edit_image: limits.timeout_ms leaves no time to read the input images before the generation");
  return {
    name: "edit_image",
    title: "Edit image",
    description: `Edit or combine up to ${MAX_INPUT_IMAGES} images with a prompt using a Gemini image model (paid). Images: https URLs or files inside $${uploadDirEnv}. The result is saved like generate_image`,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, description: "The edit to make, e.g. Put a party hat on the cat" },
        images: { type: "array", items: { type: "string" }, maxItems: MAX_INPUT_IMAGES, description: `Input images: https URLs or absolute paths inside $${uploadDirEnv} (20 MB in total once base64-encoded, about 15 MB of files)` },
        model: { type: "string", default: defaultModel, description: "Image model, e.g. gemini-nano-banana-2.1, gemini-3-pro-image" },
        aspect_ratio: { type: "string", enum: aspectRatios, description: "Output aspect ratio (default: from the input)" },
        image_size: { type: "string", enum: imageSizes, description: "Output size; larger costs more" },
      },
      required: ["prompt", "images"],
    },
    run: async (context) => {
      const startedAt = Date.now();
      const imageBlocks = await readImagesWithinBudget(context, uploadDirEnv, readBudgetMs);
      assertTimeLeftForGeneration(startedAt, readBudgetMs, generationTimeoutMs);
      const textBlock = { type: "text", text: context.args.prompt };
      assertInlineRequestSize(textBlock, imageBlocks);
      const interactionArgs = { model: context.args.model, input: [textBlock, ...imageBlocks], response_format: buildResponseFormat(context.args) };
      return createInteractionOperation.run({ ...context, args: interactionArgs });
    },
  };
}

async function readImagesWithinBudget(context, uploadDirEnv, readBudgetMs) {
  const readTimeout = AbortSignal.timeout(readBudgetMs);
  const readSignal = context.signal ? AbortSignal.any([context.signal, readTimeout]) : readTimeout;
  try {
    return await readImageBlocks(context.args.images, { ...context, signal: readSignal }, uploadDirEnv);
  } catch (readError) {
    if (!readTimeout.aborted || context.signal?.aborted) throw readError;
    throw new PluginError(`Reading the input images took longer than ${Math.round(readBudgetMs / 1000)} s; nothing was sent to Google`, { kind: "timeout", retryable: true });
  }
}

function assertTimeLeftForGeneration(startedAt, readBudgetMs, generationTimeoutMs) {
  if (Date.now() - startedAt <= readBudgetMs) return;
  const message = `Reading the input images left too little time to wait for the generation (it may take ${Math.round(generationTimeoutMs / 1000)} s); nothing was sent to Google. Use smaller or local images`;
  throw new PluginError(message, { kind: "timeout", retryable: false });
}

/**
 * Reads every input image into an Interactions image block, within the count limit.
 *
 * @param imageReferences - URLs or local paths (string[])
 * @param context - Operation context `{client, environment, signal}` (object)
 * @param uploadDirEnv - Upload allowlist env var (string)
 * @returns `[{type: "image", mime_type, data}]` (Promise<object[]>)
 * @throws PluginError kind `invalid_input` - No images, too many, not an image, outside the allowlist, too large
 */
export async function readImageBlocks(imageReferences, context, uploadDirEnv) {
  if (!Array.isArray(imageReferences) || imageReferences.length === 0) throw invalidImages("`images` needs at least one image");
  if (imageReferences.length > MAX_INPUT_IMAGES) throw invalidImages(`\`images\` takes at most ${MAX_INPUT_IMAGES} images`);
  const imageBlocks = [];
  for (const [index, imageReference] of imageReferences.entries()) {
    const imageInput = await readOneImage(String(imageReference), `images[${index}]`, context, uploadDirEnv);
    imageBlocks.push({ type: "image", mime_type: imageInput.mimeType, data: Buffer.from(imageInput.bytes).toString("base64") });
  }
  return imageBlocks;
}

function assertInlineRequestSize(textBlock, imageBlocks) {
  const requestBytes = REQUEST_ENVELOPE_BYTES + Buffer.byteLength(textBlock.text) + imageBlocks.reduce((total, imageBlock) => total + imageBlock.data.length, 0);
  if (requestBytes <= MAX_INLINE_REQUEST_BYTES) return;
  throw invalidImages(`the prompt and base64-encoded images come to ${requestBytes} bytes, over the 20 MB inline request limit; use fewer or smaller images`);
}

async function readOneImage(imageReference, paramName, { client, environment, signal }, uploadDirEnv) {
  const fileInput = await readFileInput(imageReference, {
    paramName,
    fileDirEnv: uploadDirEnv,
    environment,
    maxBytes: MAX_IMAGE_BYTES,
    fetchImpl: client.fetchImpl,
    resolveHostAddresses: client.resolveHostAddresses,
    signal,
  });
  const mimeType = resolveImageType(fileInput);
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) throw invalidImages(`\`${paramName}\` is not a supported image (got ${mimeType}); use png, jpeg, webp, heic, heif, gif, bmp or tiff`);
  return { bytes: fileInput.bytes, mimeType };
}

// Trust a declared image/* type; otherwise (octet-stream, unknown extensions) sniff the bytes.
function resolveImageType(fileInput) {
  const declaredType = String(fileInput.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(declaredType)) return declaredType;
  return sniffMediaType(Buffer.from(fileInput.bytes));
}

function buildResponseFormat({ aspect_ratio: aspectRatio, image_size: imageSize }) {
  return { type: "image", ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}), ...(imageSize ? { image_size: imageSize } : {}) };
}

function invalidImages(message) {
  return new PluginError(message, { kind: "invalid_input" });
}
