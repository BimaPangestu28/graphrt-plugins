/**
 * ocr-tesseract operations: list_languages and ocr (an image, or one PDF page rendered with pdftoppm).
 */
import { buildNameHint, OUTPUT_NAME_PARAMETER } from "../lib/file-access.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { detectRasterFormat } from "../lib/raster-format.mjs";
import { readImageDimensions } from "../lib/image-dimensions.mjs";

const IMAGE_FORMATS = ["png", "jpeg", "tiff", "bmp", "gif", "webp"];
const LANGUAGE_PATTERN = /^[A-Za-z0-9_]{1,40}$/;
const MAX_LANGUAGES = 5;
const OUTPUT_EXTENSIONS = { text: "txt", hocr: "hocr", tsv: "tsv" };

const listLanguagesOperation = {
  name: "list_languages",
  title: "List OCR languages",
  description: "Lists the Tesseract language packs installed on this machine (codes such as eng, ind, chi_sim) for the `languages` parameter of ocr",
  parameters: { type: "object", properties: {} },
  run: async ({ client, signal }) => ({ data: await client.listLanguages(signal) }),
};

/**
 * Checks requested languages against the pattern and the installed list.
 *
 * @param requested - Language codes (string[])
 * @param installed - Installed codes (string[])
 * @returns The validated codes (string[])
 * @throws PluginError kind `invalid_input` - When a code is malformed or not installed
 */
export function validateLanguages(requested, installed) {
  if (requested.length === 0 || requested.length > MAX_LANGUAGES) throw invalidInput(`\`languages\` needs 1 to ${MAX_LANGUAGES} language codes`);
  for (const language of requested) {
    if (!LANGUAGE_PATTERN.test(language)) throw invalidInput(`\`languages\`: ${JSON.stringify(language)} is not a language code`);
    if (!installed.includes(language)) throw invalidInput(`Language ${JSON.stringify(language)} is not installed; installed: ${installed.join(", ")}`);
  }
  return requested;
}

const POINTS_PER_INCH = 72;
const MEDIA_BOX_PATTERN = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g;

// Content decides: a raster image goes straight to tesseract, a PDF is rendered first, anything else is refused
// (tesseract would read a text file as a list of other images to open).
function classifyInput(bytes) {
  const rasterFormat = detectRasterFormat(bytes);
  if (rasterFormat && IMAGE_FORMATS.includes(rasterFormat)) return { kind: "image", rasterFormat };
  if (bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) return { kind: "pdf", rasterFormat: null };
  throw invalidInput(`\`input\` must be a ${IMAGE_FORMATS.join(", ")} image or a PDF (detected from its content)`);
}

/**
 * Refuses an image whose header declares more pixels than the cap (tesseract would decode all of them).
 *
 * @param bytes - Image contents (Buffer)
 * @param rasterFormat - Detected format (string)
 * @param maxPixels - Cap (number)
 * @throws PluginError kind `invalid_input` - When the image is over the cap or its header is malformed
 */
export function assertImageWithinPixels(bytes, rasterFormat, maxPixels) {
  const { width, height } = readImageDimensions(bytes, rasterFormat);
  if (width * height > maxPixels) throw invalidInput(`The image is ${width}x${height}, over the ${maxPixels}-pixel limit (OCR_TESSERACT_MAX_INPUT_PIXELS)`);
}

/**
 * Works out how large a rendered PDF page may be: from the largest /MediaBox found in the file when there is
 * one (refusing pages that would exceed the cap at this dpi), else a square of the cap's area.
 *
 * @param bytes - PDF contents (Buffer)
 * @param dpi - Render resolution (number)
 * @param maxPixels - Cap (number)
 * @returns `{width, height}` crop size in pixels for pdftoppm (object)
 * @throws PluginError kind `invalid_input` - When the largest page would exceed the cap at this dpi
 */
export function planPdfRender(bytes, dpi, maxPixels) {
  let largest = null;
  for (const match of bytes.toString("latin1").matchAll(MEDIA_BOX_PATTERN)) {
    const [left, bottom, right, top] = match.slice(1, 5).map(Number);
    const size = { width: Math.ceil((Math.abs(right - left) * dpi) / POINTS_PER_INCH), height: Math.ceil((Math.abs(top - bottom) * dpi) / POINTS_PER_INCH) };
    if (!largest || size.width * size.height > largest.width * largest.height) largest = size;
  }
  if (!largest) {
    const side = Math.floor(Math.sqrt(maxPixels));
    return { width: side, height: side };
  }
  if (largest.width * largest.height > maxPixels) {
    throw invalidInput(`A page renders to ${largest.width}x${largest.height} pixels at ${dpi} dpi, over the ${maxPixels}-pixel limit (OCR_TESSERACT_MAX_INPUT_PIXELS); lower \`dpi\``);
  }
  return largest;
}

async function recognizeInput(client, { path, bytes, kind, args, languages, signal }) {
  const request = { languages, psm: args.psm, outputFormat: args.output_format, signal };
  if (kind === "image") return client.recognize({ ...request, imagePath: path });
  const maxSide = planPdfRender(bytes, args.dpi, client.settings.maxInputPixels);
  return client.withRenderedPdfPage({ pdfPath: path, page: args.page, dpi: args.dpi, maxSide, signal }, (pngPath) => client.recognize({ ...request, imagePath: pngPath, dpi: args.dpi }));
}

const ocrOperation = {
  name: "ocr",
  title: "Recognise text",
  description: "Reads text from an image (png, jpeg, tiff, bmp, gif, webp) or one page of a PDF with Tesseract, as plain text, hOCR (HTML with word boxes) or TSV (word, box, confidence); optionally saves it to OCR_TESSERACT_OUTPUT_DIR",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "Image or PDF inside OCR_TESSERACT_INPUT_DIRS (or OCR_TESSERACT_OUTPUT_DIR); absolute, ~/..., or relative to the first input directory" },
      languages: { type: "array", items: { type: "string" }, maxItems: MAX_LANGUAGES, default: ["eng"], description: "Installed language codes, e.g. [\"eng\", \"ind\"] (see list_languages)" },
      psm: { type: "integer", minimum: 0, maximum: 13, default: 3, description: "Page segmentation mode: 3 automatic (default), 4 one column, 6 one block, 7 one line, 11 sparse text" },
      output_format: { type: "string", enum: ["text", "hocr", "tsv"], default: "text", description: "Result format" },
      page: { type: "integer", minimum: 1, maximum: 100000, default: 1, description: "PDF page to read (1-based)" },
      dpi: { type: "integer", minimum: 72, maximum: 600, default: 300, description: "Resolution PDF pages are rendered at" },
      max_chars: { type: "integer", minimum: 100, maximum: 2000000, default: 200000, description: "Most characters returned" },
      save_output: { type: "boolean", default: false, description: "Also write the result to a new file in OCR_TESSERACT_OUTPUT_DIR" },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    const { languages: installed } = await client.listLanguages(signal);
    const languages = validateLanguages(args.languages, installed);
    const { path, bytes } = await client.fileAccess.readInputFile(args.input);
    const { kind, rasterFormat } = classifyInput(bytes);
    if (kind === "image") assertImageWithinPixels(bytes, rasterFormat, client.settings.maxInputPixels);
    const { text, truncated } = await recognizeInput(client, { path, bytes, kind, args, languages, signal });
    const isCut = truncated || text.length > args.max_chars;
    const result = { path, input_kind: kind, page: kind === "pdf" ? args.page : null, languages, psm: args.psm, format: args.output_format, text: text.slice(0, args.max_chars), truncated: isCut };
    if (!args.save_output) return { data: result };
    const saved = await client.fileAccess.writeOutputFile({ nameHint: buildNameHint(args.output_name, path), extension: OUTPUT_EXTENSIONS[args.output_format] }, Buffer.from(text, "utf8"));
    return { data: { ...result, saved } };
  },
};

export const ocrOperations = [listLanguagesOperation, ocrOperation];
