/**
 * Read and transform operations: metadata, resize, crop, rotate, convert,
 * compress and thumbnails. Every transform auto-orients from EXIF first and
 * writes a new file without the input's metadata.
 */
import { chooseOutputFormat } from "../lib/client.mjs";
import { buildNameHint } from "../lib/file-access.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { normalizeHexColor } from "../lib/watermark.mjs";
import { DIMENSION_SCHEMA, FORMAT_PARAMETER, INPUT_PARAMETER, OUTPUT_NAME_PARAMETER, QUALITY_PARAMETER } from "./parameters.mjs";

const FIT_MODES = ["inside", "cover", "contain", "fill", "outside"];
const MAX_THUMBNAILS = 10;

/**
 * Opens the input, applies `transform` to an auto-oriented pipeline and saves the result.
 *
 * @param client - image client (object)
 * @param request - `{args, signal, transform: (pipeline, image) => pipeline, openedImage}`; openedImage skips re-reading the input (object)
 * @returns Saved output description (object)
 */
export async function transformAndSave(client, { args, signal, transform, openedImage }) {
  const image = openedImage ?? (await client.openImage(args.input));
  const pipeline = transform(image.createPipeline().autoOrient(), image);
  const format = chooseOutputFormat(args.format, image.format);
  return client.saveImage({ pipeline, format, quality: args.quality, nameHint: buildNameHint(args.output_name, image.realPath), signal });
}

const metadataOperation = {
  name: "metadata",
  title: "Read image metadata",
  description: "Format, displayed width and height (after EXIF orientation), channels, colour space, alpha, density, pages and whether EXIF/ICC/XMP data is present",
  parameters: { type: "object", properties: { input: INPUT_PARAMETER }, required: ["input"] },
  run: async ({ client, args }) => {
    const { realPath, bytes, format, metadata } = await client.openImage(args.input);
    return {
      data: {
        path: realPath, size_bytes: bytes.length, format, width: metadata.width, height: metadata.height,
        orientation: metadata.orientation ?? 1,
        channels: metadata.channels, color_space: metadata.space ?? null, has_alpha: Boolean(metadata.hasAlpha), density: metadata.density ?? null,
        pages: metadata.pages ?? 1, is_progressive: Boolean(metadata.isProgressive), has_exif: Boolean(metadata.exif), has_icc: Boolean(metadata.icc), has_xmp: Boolean(metadata.xmp),
      },
    };
  },
};

const resizeOperation = {
  name: "resize",
  title: "Resize an image",
  description: "Resizes to target_width and/or target_height (the other side keeps the aspect ratio). `fit` decides how both sides are used: inside (default), cover (crop), contain (pad), fill (stretch), outside",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      target_width: { ...DIMENSION_SCHEMA, description: "Target width in pixels" },
      target_height: { ...DIMENSION_SCHEMA, description: "Target height in pixels" },
      fit: { type: "string", enum: FIT_MODES, default: "inside", description: "How to fit both sides" },
      enlarge: { type: "boolean", default: false, description: "Allow making the image bigger than the original" },
      background: { type: "string", default: "#ffffff", description: "Padding colour for fit=contain (hex)" },
      format: FORMAT_PARAMETER,
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    if (args.target_width === undefined && args.target_height === undefined) throw invalidInput("Pass `target_width`, `target_height` or both");
    const background = normalizeHexColor(args.background);
    const transform = (pipeline) => pipeline.resize({ width: args.target_width, height: args.target_height, fit: args.fit, background, withoutEnlargement: !args.enlarge });
    return { data: await transformAndSave(client, { args, signal, transform }) };
  },
};

const cropOperation = {
  name: "crop",
  title: "Crop an image",
  description: "Cuts out a rectangle given by left, top, crop_width and crop_height in pixels of the displayed (auto-oriented) image",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      left: { type: "integer", minimum: 0, maximum: 100000, description: "Left edge in pixels" },
      top: { type: "integer", minimum: 0, maximum: 100000, description: "Top edge in pixels" },
      crop_width: { ...DIMENSION_SCHEMA, description: "Width of the box in pixels" },
      crop_height: { ...DIMENSION_SCHEMA, description: "Height of the box in pixels" },
      format: FORMAT_PARAMETER,
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input", "left", "top", "crop_width", "crop_height"],
  },
  run: async ({ client, args, signal }) => {
    const transform = (pipeline, image) => {
      if (args.left + args.crop_width > image.metadata.width || args.top + args.crop_height > image.metadata.height) {
        throw invalidInput(`The crop box ${args.left},${args.top} ${args.crop_width}x${args.crop_height} does not fit inside the ${image.metadata.width}x${image.metadata.height} image`);
      }
      return pipeline.extract({ left: args.left, top: args.top, width: args.crop_width, height: args.crop_height });
    };
    return { data: await transformAndSave(client, { args, signal, transform }) };
  },
};

const rotateOperation = {
  name: "rotate",
  title: "Rotate or flip an image",
  description: "Rotates by any angle (multiples of 90 are lossless in size; other angles fill corners with `background`) and optionally mirrors vertically (flip) or horizontally (flop)",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      angle: { type: "number", minimum: -360, maximum: 360, default: 0, description: "Clockwise angle in degrees" },
      flip: { type: "boolean", default: false, description: "Mirror top to bottom" },
      flop: { type: "boolean", default: false, description: "Mirror left to right" },
      background: { type: "string", default: "#000000", description: "Corner fill colour for non-right angles (hex)" },
      format: FORMAT_PARAMETER,
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    const background = normalizeHexColor(args.background);
    const transform = (pipeline) => {
      const rotated = args.angle !== 0 ? pipeline.rotate(args.angle, { background }) : pipeline;
      return rotated.flip(args.flip).flop(args.flop);
    };
    return { data: await transformAndSave(client, { args, signal, transform }) };
  },
};

const convertOperation = {
  name: "convert",
  title: "Convert an image",
  description: "Re-encodes an image as jpeg, png, webp, avif, gif or tiff",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      format: { ...FORMAT_PARAMETER, description: "Output format" },
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input", "format"],
  },
  run: async ({ client, args, signal }) => ({ data: await transformAndSave(client, { args, signal, transform: (pipeline) => pipeline }) }),
};

const compressOperation = {
  name: "compress",
  title: "Compress an image",
  description: "Re-encodes at a lower quality (default 75) without metadata, optionally capping the longest side; reports the size saved",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      quality: { ...QUALITY_PARAMETER, default: 75 },
      max_dimension: { ...DIMENSION_SCHEMA, description: "Shrink so neither side is longer than this" },
      format: FORMAT_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    let originalBytes = 0;
    const transform = (pipeline, image) => {
      originalBytes = image.bytes.length;
      return args.max_dimension ? pipeline.resize({ width: args.max_dimension, height: args.max_dimension, fit: "inside", withoutEnlargement: true }) : pipeline;
    };
    const outputFile = await transformAndSave(client, { args, signal, transform });
    return { data: { ...outputFile, original_size_bytes: originalBytes, saved_bytes: originalBytes - outputFile.size_bytes } };
  },
};

const thumbnailsOperation = {
  name: "thumbnails",
  title: "Make thumbnails",
  description: "Writes up to 10 thumbnails of one image at the given widths (aspect ratio kept, never enlarged), default webp",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      widths: { type: "array", items: { type: "integer" }, maxItems: MAX_THUMBNAILS, default: [128, 256, 512], description: "Widths in pixels (1-16383)" },
      format: { ...FORMAT_PARAMETER, default: "webp" },
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    const widths = validateWidths(args.widths);
    const image = await client.openImage(args.input);
    const requests = widths.map((width) => ({
      pipeline: image.createPipeline().autoOrient().resize({ width, withoutEnlargement: true }),
      format: args.format,
      quality: args.quality,
      nameHint: `${buildNameHint(args.output_name, image.realPath)}-${width}w`,
      signal,
    }));
    return { data: { thumbnails: await client.saveImages(requests) } };
  },
};

function validateWidths(widths) {
  if (widths.length === 0) throw invalidInput("`widths` needs at least one width");
  if (widths.some((width) => width < 1 || width > 16383)) throw invalidInput("Each width must be from 1 to 16383");
  return [...new Set(widths)];
}

export const transformOperations = [metadataOperation, resizeOperation, cropOperation, rotateOperation, convertOperation, compressOperation, thumbnailsOperation];
