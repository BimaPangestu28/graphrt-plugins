/**
 * watermark: a line of text (rendered from a plugin-built SVG) or a second
 * allowlisted image, placed at a position with a margin and opacity.
 */
import { invalidInput } from "../lib/errors.mjs";
import { buildTextSvg, computeOverlayPosition, normalizeHexColor, POSITIONS } from "../lib/watermark.mjs";
import { transformAndSave } from "./transform.mjs";
import { FORMAT_PARAMETER, INPUT_PARAMETER, OUTPUT_NAME_PARAMETER, QUALITY_PARAMETER } from "./parameters.mjs";

const MAX_TEXT_LENGTH = 200;

/**
 * Builds the overlay buffer and its size for a text or image watermark.
 *
 * @param client - image client (object)
 * @param args - Operation arguments (object)
 * @param base - `{width, height}` of the displayed input image (object)
 * @returns `{input, width, height}` ready for sharp's composite (object)
 */
async function buildOverlay(client, args, base) {
  if (args.text !== undefined) {
    const fontSize = args.font_size ?? Math.max(12, Math.round(base.width / 25));
    const { svg, width, height } = buildTextSvg({ text: args.text, fontSize, color: normalizeHexColor(args.color), opacity: args.opacity, maxWidth: base.width, maxHeight: base.height });
    return { input: Buffer.from(svg), width, height };
  }
  const overlayImage = await client.openImage(args.image, "image");
  const targetWidth = Math.max(1, Math.round(base.width * args.image_scale));
  const resized = overlayImage.createPipeline().autoOrient().resize({ width: targetWidth, height: base.height, fit: "inside" }).ensureAlpha();
  const faded = resized.composite([{ input: Buffer.from([255, 255, 255, Math.round(args.opacity * 255)]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: "dest-in" }]);
  const { data, info } = await faded.png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

const watermarkOperation = {
  name: "watermark",
  title: "Add a watermark",
  description: "Places a text line or a second image (scaled to a share of the width) on an image at one of nine positions, with margin and opacity",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      text: { type: "string", description: `Watermark text (at most ${MAX_TEXT_LENGTH} characters); pass this or \`image\`` },
      image: { type: "string", description: "Watermark image inside IMAGE_TOOLS_INPUT_DIRS; pass this or `text`" },
      placement: { type: "string", enum: POSITIONS, default: "bottom-right", description: "Where to place it" },
      margin: { type: "integer", minimum: 0, maximum: 2000, default: 16, description: "Distance from the edges in pixels" },
      opacity: { type: "number", minimum: 0.05, maximum: 1, default: 0.6, description: "Opacity 0.05-1" },
      font_size: { type: "integer", minimum: 6, maximum: 1000, description: "Text size in pixels (default: 1/25 of the width)" },
      color: { type: "string", default: "#ffffff", description: "Text colour (hex)" },
      image_scale: { type: "number", minimum: 0.02, maximum: 1, default: 0.2, description: "Watermark image width as a share of the input width" },
      format: FORMAT_PARAMETER,
      quality: QUALITY_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    if ((args.text === undefined) === (args.image === undefined)) throw invalidInput("Pass either `text` or `image`");
    if (args.text !== undefined && args.text.length > MAX_TEXT_LENGTH) throw invalidInput(`\`text\` must be at most ${MAX_TEXT_LENGTH} characters`);
    const image = await client.openImage(args.input);
    const overlay = await buildOverlay(client, args, image.metadata);
    const { left, top } = computeOverlayPosition(args.placement, image.metadata, overlay, args.margin);
    const transform = (pipeline) => pipeline.composite([{ input: overlay.input, left, top }]);
    return { data: await transformAndSave(client, { args, signal, transform, openedImage: image }) };
  },
};

export const watermarkOperations = [watermarkOperation];
