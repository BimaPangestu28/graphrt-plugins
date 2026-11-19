/**
 * pdf-tools operations. Reading (info, extract_text) needs only the input
 * allowlist; the others write new PDFs to PDF_TOOLS_OUTPUT_DIR.
 */
import { buildNameHint, OUTPUT_NAME_PARAMETER } from "../lib/file-access.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { assertRasterFormat } from "../lib/raster-format.mjs";
import { normalizeHexColor } from "../lib/colors.mjs";

const INPUT_PARAMETER = { type: "string", description: "PDF file inside PDF_TOOLS_INPUT_DIRS (or PDF_TOOLS_OUTPUT_DIR); absolute, ~/..., or relative to the first input directory" };
const PAGES_PARAMETER = { type: "string", description: "Pages such as \"1-3,5,8-\" (1-based; default: all pages)" };
const MAX_MERGE_INPUTS = 50;
const MAX_IMAGES = 200;

const infoOperation = {
  name: "info",
  title: "Read PDF info",
  description: "Page count, whether the PDF is encrypted, document metadata (title, author, subject, keywords, creator, producer, dates) and the size and rotation of up to 100 pages",
  parameters: { type: "object", properties: { input: INPUT_PARAMETER }, required: ["input"] },
  run: async ({ client, args, signal }) => {
    const { path, bytes } = await client.readPdf(args.input);
    const { data } = await client.runTask("inspect", { bytes }, signal);
    return { data: { path, size_bytes: bytes.length, ...data } };
  },
};

const extractTextOperation = {
  name: "extract_text",
  title: "Extract PDF text",
  description: "Extracts the text layer per page (no OCR: scanned pages come back empty; use ocr-tesseract for those), capped at max_chars",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      pages: PAGES_PARAMETER,
      max_chars: { type: "integer", minimum: 100, maximum: 2000000, default: 100000, description: "Most characters returned in total" },
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    const { path, bytes } = await client.readPdf(args.input);
    const { data } = await client.runTask("extract_text", { bytes, pages: args.pages, maxChars: args.max_chars }, signal);
    return { data: { path, ...data } };
  },
};

const mergeOperation = {
  name: "merge",
  title: "Merge PDFs",
  description: "Joins 2-50 PDFs in the given order into one new PDF",
  parameters: {
    type: "object",
    properties: {
      inputs: { type: "array", items: { type: "string" }, maxItems: MAX_MERGE_INPUTS, description: "PDF files in order, each inside PDF_TOOLS_INPUT_DIRS" },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["inputs"],
  },
  run: async ({ client, args, signal }) => {
    if (args.inputs.length < 2) throw invalidInput("`inputs` needs at least 2 PDFs");
    const files = await client.readInputs(args.inputs, (rawPath, index) => client.readPdf(rawPath, `inputs[${index}]`));
    const documents = files.map((file) => file.bytes);
    const { data, outputs } = await client.runTask("merge", { documents }, signal);
    const [outputFile] = await client.saveOutputs(outputs, [buildNameHint(args.output_name ?? "merged")]);
    return { data: { ...outputFile, ...data } };
  },
};

const extractPagesOperation = {
  name: "extract_pages",
  title: "Extract pages",
  description: "Copies the selected pages (in the order given, e.g. \"3,1-2\") into one new PDF",
  parameters: { type: "object", properties: { input: INPUT_PARAMETER, pages: { ...PAGES_PARAMETER, description: "Pages such as \"1-3,5\" (1-based)" }, output_name: OUTPUT_NAME_PARAMETER }, required: ["input", "pages"] },
  run: async ({ client, args, signal }) => {
    const { path, bytes } = await client.readPdf(args.input);
    const { data, outputs } = await client.runTask("extract_pages", { bytes, pages: args.pages }, signal);
    const [outputFile] = await client.saveOutputs(outputs, [buildNameHint(args.output_name, path)]);
    return { data: { ...outputFile, ...data } };
  },
};

const splitOperation = {
  name: "split",
  title: "Split a PDF",
  description: "Splits a PDF into several new PDFs: one per entry of `ranges` (e.g. [\"1-2\", \"3-\"]), or every N pages (default 1: one file per page); at most 200 files",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      ranges: { type: "array", items: { type: "string" }, maxItems: 200, description: "Page selections, one output each" },
      every: { type: "integer", minimum: 1, maximum: 100000, description: "Pages per output when `ranges` is not given (default 1)" },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    if (args.ranges?.length && args.every !== undefined) throw invalidInput("Pass `ranges` or `every`, not both");
    const { path, bytes } = await client.readPdf(args.input);
    const { data, outputs } = await client.runTask("split", { bytes, ranges: args.ranges, every: args.every }, signal);
    const nameHint = buildNameHint(args.output_name, path);
    const files = await client.saveOutputs(outputs, data.parts.map((_, index) => `${nameHint}-part${index + 1}`));
    return { data: { files: files.map((file, index) => ({ ...file, pages: data.parts[index].pages })) } };
  },
};

const rotateOperation = {
  name: "rotate",
  title: "Rotate pages",
  description: "Rotates the selected pages (default all) clockwise by 90, 180 or 270 degrees and writes a new PDF",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      degrees: { type: "integer", enum: [90, 180, 270, -90], default: 90, description: "Clockwise rotation" },
      pages: PAGES_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal }) => {
    const { path, bytes } = await client.readPdf(args.input);
    const { data, outputs } = await client.runTask("rotate", { bytes, degrees: args.degrees, pages: args.pages }, signal);
    const [outputFile] = await client.saveOutputs(outputs, [buildNameHint(args.output_name, path)]);
    return { data: { ...outputFile, ...data } };
  },
};

const watermarkOperation = {
  name: "watermark",
  title: "Add a text watermark",
  description: "Draws a text watermark (Helvetica, Latin-1 characters) on the selected pages: centred, top or bottom, rotated, with colour and opacity",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      text: { type: "string", minLength: 1, description: "Watermark text (at most 200 characters)" },
      font_size: { type: "integer", minimum: 4, maximum: 300, default: 48, description: "Size in points" },
      opacity: { type: "number", minimum: 0.05, maximum: 1, default: 0.25, description: "Opacity 0.05-1" },
      angle: { type: "number", minimum: -90, maximum: 90, default: 45, description: "Counter-clockwise rotation in degrees" },
      color: { type: "string", default: "#ff0000", description: "Text colour (hex)" },
      placement: { type: "string", enum: ["center", "top", "bottom"], default: "center", description: "Vertical placement" },
      pages: PAGES_PARAMETER,
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input", "text"],
  },
  run: async ({ client, args, signal }) => {
    if (args.text.length > 200) throw invalidInput("`text` must be at most 200 characters");
    const color = hexToUnitRgb(normalizeHexColor(args.color));
    const { path, bytes } = await client.readPdf(args.input);
    const payload = { bytes, text: args.text, fontSize: args.font_size, opacity: args.opacity, angle: args.angle, color, placement: args.placement, pages: args.pages };
    const { data, outputs } = await client.runTask("watermark", payload, signal);
    const [outputFile] = await client.saveOutputs(outputs, [buildNameHint(args.output_name, path)]);
    return { data: { ...outputFile, ...data } };
  },
};

function hexToUnitRgb(hexColor) {
  return [1, 3, 5].map((offset) => parseInt(hexColor.slice(offset, offset + 2), 16) / 255);
}

const imagesToPdfOperation = {
  name: "images_to_pdf",
  title: "Images to PDF",
  description: "Builds a PDF with one jpeg or png image per page: pages sized to each image (fit), or A4/Letter with the image scaled down to fit and centred",
  parameters: {
    type: "object",
    properties: {
      images: { type: "array", items: { type: "string" }, maxItems: MAX_IMAGES, description: "jpeg/png files in page order, each inside PDF_TOOLS_INPUT_DIRS" },
      page_size: { type: "string", enum: ["fit", "a4", "letter"], default: "fit", description: "Page size (a4/letter turn landscape for wide images)" },
      margin: { type: "integer", minimum: 0, maximum: 200, default: 0, description: "Margin in points" },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["images"],
  },
  run: async ({ client, args, signal }) => {
    if (args.images.length === 0) throw invalidInput("`images` needs at least one image");
    const files = await client.readInputs(args.images, (rawPath, index) => client.fileAccess.readInputFile(rawPath, { parameterName: `images[${index}]` }));
    const images = files.map(({ bytes }, index) => ({ bytes, format: assertRasterFormat(bytes, ["jpeg", "png"], `\`images[${index}]\``) }));
    const { data, outputs } = await client.runTask("images_to_pdf", { images, pageSize: args.page_size, margin: args.margin }, signal);
    const [outputFile] = await client.saveOutputs(outputs, [buildNameHint(args.output_name ?? "images")]);
    return { data: { ...outputFile, ...data } };
  },
};

export const pdfOperations = [infoOperation, extractTextOperation, mergeOperation, extractPagesOperation, splitOperation, rotateOperation, watermarkOperation, imagesToPdfOperation];
