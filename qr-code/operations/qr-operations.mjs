/**
 * qr-code operations: generate (to a new PNG or SVG file) and decode (from an allowlisted image).
 */
import { buildNameHint, OUTPUT_NAME_PARAMETER } from "../lib/file-access.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { normalizeHexColor } from "../lib/colors.mjs";
import { decodeQrCodes, renderQrCode } from "../lib/qr-engine.mjs";

const MAX_TEXT_LENGTH = 4296;

const generateOperation = {
  name: "generate",
  title: "Generate a QR code",
  description: "Encodes text or a URL as a QR code and writes it as a new PNG or SVG file in QR_CODE_OUTPUT_DIR (error correction, margin, size and colours adjustable)",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, description: `Text or URL to encode (at most ${MAX_TEXT_LENGTH} characters; less at higher error correction)` },
      format: { type: "string", enum: ["png", "svg"], default: "png", description: "Output format" },
      error_correction: { type: "string", enum: ["L", "M", "Q", "H"], default: "M", description: "Error correction: L 7%, M 15%, Q 25%, H 30% of the code can be damaged" },
      module_size: { type: "integer", minimum: 1, maximum: 50, default: 8, description: "Pixels per QR module (PNG)" },
      image_size: { type: "integer", minimum: 32, maximum: 4096, description: "Total image width in pixels; overrides module_size" },
      margin: { type: "integer", minimum: 0, maximum: 20, default: 4, description: "Quiet zone in modules" },
      dark_color: { type: "string", default: "#000000", description: "Module colour (hex)" },
      light_color: { type: "string", default: "#ffffff", description: "Background colour (hex)" },
      include_data: { type: "boolean", default: false, description: "Also return the SVG text, or the PNG as a data: URL" },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["text"],
  },
  run: async ({ client, args }) => {
    if (args.text.length > MAX_TEXT_LENGTH) throw invalidInput(`\`text\` must be at most ${MAX_TEXT_LENGTH} characters`);
    const request = {
      text: args.text, format: args.format, errorCorrection: args.error_correction, margin: args.margin, moduleSize: args.module_size, imageSize: args.image_size,
      darkColor: normalizeHexColor(args.dark_color, "dark_color"), lightColor: normalizeHexColor(args.light_color, "light_color"),
      maxPixels: client.settings.maxOutputPixels,
    };
    const bytes = await renderQrCode(request);
    const outputFile = await client.fileAccess.writeOutputFile({ nameHint: buildNameHint(args.output_name ?? "qr"), extension: args.format }, bytes);
    const inlineData = args.format === "svg" ? bytes.toString("utf8") : `data:image/png;base64,${bytes.toString("base64")}`;
    return { data: { ...outputFile, format: args.format, ...(args.include_data ? { data: inlineData } : {}) } };
  },
};

const decodeOperation = {
  name: "decode",
  title: "Decode QR codes",
  description: "Finds and decodes QR codes (also Micro QR and rMQR) in a png, jpeg, gif or bmp image, returning each code's text, error correction level and corner positions",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "Image inside QR_CODE_INPUT_DIRS (or QR_CODE_OUTPUT_DIR); absolute, ~/..., or relative to the first input directory" },
      max_codes: { type: "integer", minimum: 1, maximum: 20, default: 4, description: "Most codes to return" },
      try_harder: { type: "boolean", default: true, description: "Spend more time: also try rotated and inverted images" },
    },
    required: ["input"],
  },
  run: async ({ client, args }) => {
    const image = await client.readDecodableImage(args.input);
    const codes = await decodeQrCodes(image.bytes, { maxCodes: args.max_codes, tryHarder: args.try_harder });
    return { data: { path: image.path, width: image.width, height: image.height, count: codes.length, codes } };
  },
};

export const qrOperations = [generateOperation, decodeOperation];
