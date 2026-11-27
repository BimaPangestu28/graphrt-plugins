/**
 * The PDF work itself, on bytes in and bytes out: pdf-lib for structure
 * (merge, split, rotate, watermark, images to PDF, metadata) and pdfjs-dist
 * (legacy build, eval disabled) for text. It runs inside the worker process
 * (pdf-worker.mjs), so a hostile PDF can only stall or bloat a process that
 * the plugin kills (timeout, cancel, or the RSS watchdog in isolated-task.mjs,
 * which also catches inflated streams outside the V8 heap); it never touches
 * the file system.
 *
 * Protected (encrypted) PDFs are opened first (pdf-protection.mjs) and what
 * their publisher forbids is refused here: copying text, rearranging pages,
 * changing pages. The permissions password lifts that. Results are written
 * without protection.
 */
import { invalidInput, operationFailed } from "./errors.mjs";
import { parsePageSelection } from "./page-ranges.mjs";
import { PASSWORD_NEEDED, mayBeProtected, openProtectedPdf } from "./pdf-protection.mjs";

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
const MAX_SPLIT_OUTPUTS = 200;

/** What an operation does with a PDF, and the publisher's permission it needs for that. */
const USES = {
  copy_text: { permission: "isTextCopyingAllowed", lockedAgainst: "having its text copied out" },
  assemble_pages: { permission: "isPageAssemblyAllowed", lockedAgainst: "having its pages joined, taken out or rotated" },
  change_pages: { permission: "isChangingAllowed", lockedAgainst: "having its pages changed" },
};

async function loadPdfLib() {
  return import("pdf-lib");
}

/**
 * Opens a PDF that may be protected, and refuses a use its publisher forbids.
 *
 * @param bytes - PDF bytes (Uint8Array)
 * @param access - `{password, label, use}`; use is a key of USES, or undefined for only reading what the file is (object)
 * @returns `{bytes, protection}`; bytes without protection, protection null for a PDF that has none (object)
 * @throws PluginError kind `invalid_input` - When a password is missing or wrong, or the publisher forbids the use
 */
async function openPdf(bytes, { password, label = "input", use } = {}) {
  if (!mayBeProtected(bytes)) return { bytes, protection: null };
  const opened = await openProtectedPdf({ bytes, password, label });
  if (use && opened.protection && !opened.protection[USES[use].permission]) {
    throw invalidInput(`The publisher of ${label} has locked it against ${USES[use].lockedAgainst}, so that is not done here either. With its permissions password (the one that lifts the restrictions, also called the owner password) given as \`password\` it is done; \`info\` shows what the file allows`);
  }
  return opened;
}

/**
 * Loads a PDF with pdf-lib, opening its protection first, and enforces the page cap.
 *
 * @param bytes - PDF bytes (Uint8Array)
 * @param maxPages - Page cap (number)
 * @param access - `{password, label, use}`, see openPdf (object)
 * @returns `{document, wasProtected}`; document is a PDFDocument without protection (object)
 * @throws PluginError kind `invalid_input` - When the PDF is unreadable, over the cap, needs a password, or its publisher forbids the use
 */
export async function loadPdfDocument(bytes, maxPages, access = {}) {
  const label = access.label ?? "input";
  const { PDFDocument } = await loadPdfLib();
  const opened = await openPdf(bytes, access);
  const document = await PDFDocument.load(opened.bytes, { updateMetadata: false, ignoreEncryption: true }).catch((loadError) => {
    throw invalidInput(`${label} is not a readable PDF: ${loadError.message}`);
  });
  if (document.isEncrypted) throw invalidInput(`${label} is protected in a way that cannot be opened here`);
  if (document.getPageCount() > maxPages) throw invalidInput(`${label} has ${document.getPageCount()} pages, over the ${maxPages}-page limit (PDF_TOOLS_MAX_PAGES)`);
  return { document, wasProtected: opened.protection !== null };
}

function describePermissions(protection) {
  return { copy_text: protection.isTextCopyingAllowed, assemble_pages: protection.isPageAssemblyAllowed, change_pages: protection.isChangingAllowed, fill_forms: protection.isFillingAllowed, print: protection.isPrintingAllowed };
}

// A PDF that asks for a password, looked at without one: that it is locked is all that can be said.
const LOCKED_PDF_INFO = Object.freeze({
  page_count: null, encrypted: true, password_required: true, permissions: null,
  title: null, author: null, subject: null, keywords: null, creator: null, producer: null, creation_date: null, modification_date: null,
  pages: [], pages_truncated: false,
});

/**
 * Page count, metadata, page sizes, and for a protected PDF what its publisher allows.
 *
 * @param request - `{bytes, maxPages, password}` (object)
 * @returns `{data}`; for a PDF that asks for a password and got none, only `encrypted` and `password_required` are known (object)
 */
export async function inspectPdf({ bytes, maxPages, password }) {
  const { PDFDocument } = await loadPdfLib();
  const opened = await openPdf(bytes, { password }).catch((openError) => {
    if (openError.reason === PASSWORD_NEEDED) return null;
    throw openError;
  });
  if (opened === null) return { data: { ...LOCKED_PDF_INFO } };
  const document = await PDFDocument.load(opened.bytes, { updateMetadata: false, ignoreEncryption: true }).catch((loadError) => {
    throw invalidInput(`input is not a readable PDF: ${loadError.message}`);
  });
  if (document.isEncrypted) throw invalidInput("input is protected in a way that cannot be opened here");
  const pageCount = document.getPageCount();
  const pages = document.getPages().slice(0, Math.min(100, maxPages)).map((page, index) => ({ page: index + 1, width: round(page.getWidth()), height: round(page.getHeight()), rotation: page.getRotation().angle }));
  return {
    data: {
      page_count: pageCount,
      encrypted: opened.protection !== null,
      password_required: false,
      permissions: opened.protection ? describePermissions(opened.protection) : null,
      title: document.getTitle() ?? null, author: document.getAuthor() ?? null, subject: document.getSubject() ?? null,
      keywords: document.getKeywords() ?? null, creator: document.getCreator() ?? null, producer: document.getProducer() ?? null,
      creation_date: toIsoDate(document.getCreationDate()), modification_date: toIsoDate(document.getModificationDate()),
      pages, pages_truncated: pageCount > pages.length,
    },
  };
}

/**
 * Extracts text per page with pdfjs-dist.
 *
 * @param request - `{bytes, pages, maxChars, maxPages, password}` (object)
 * @returns `{data: {page_count, pages: [{page, text}], text, truncated}}` (object)
 */
export async function extractPdfText({ bytes, pages, maxChars, maxPages, password }) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const opened = await openPdf(bytes, { password, use: "copy_text" });
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(opened.bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, enableXfa: false });
  try {
    const pdf = await loadingTask.promise.catch((loadError) => {
      throw invalidInput(`input is not a readable PDF: ${loadError.message}`);
    });
    if (pdf.numPages > maxPages) throw invalidInput(`input has ${pdf.numPages} pages, over the ${maxPages}-page limit (PDF_TOOLS_MAX_PAGES)`);
    return { data: await collectPageTexts(pdf, parsePageSelection(pages, pdf.numPages), maxChars) };
  } finally {
    await loadingTask.destroy();
  }
}

async function collectPageTexts(pdf, pageNumbers, maxChars) {
  const pageTexts = [];
  let remainingChars = maxChars;
  for (const pageNumber of pageNumbers) {
    if (remainingChars <= 0) break;
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : ""}`).join("").trim();
    pageTexts.push({ page: pageNumber, text: pageText.slice(0, remainingChars) });
    remainingChars -= pageText.length;
    page.cleanup();
  }
  const isTruncated = remainingChars < 0 || pageTexts.length < pageNumbers.length;
  return { page_count: pdf.numPages, pages: pageTexts, text: pageTexts.map((pageText) => pageText.text).join("\n\n"), truncated: isTruncated };
}

/**
 * Joins documents in order.
 *
 * @param request - `{documents: Uint8Array[], maxPages, password}`; the one password is used for every input that is protected (object)
 * @returns `{data: {page_count, was_protected}, outputs: [Uint8Array]}` (object)
 */
export async function mergePdfs({ documents, maxPages, password }) {
  const { PDFDocument } = await loadPdfLib();
  const merged = await PDFDocument.create();
  let wasProtected = false;
  for (const [index, bytes] of documents.entries()) {
    const { document: source, wasProtected: wasSourceProtected } = await loadPdfDocument(bytes, maxPages, { password, label: `inputs[${index}]`, use: "assemble_pages" });
    wasProtected ||= wasSourceProtected;
    if (merged.getPageCount() + source.getPageCount() > maxPages) throw invalidInput(`The merged PDF would have more than ${maxPages} pages (PDF_TOOLS_MAX_PAGES)`);
    for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
  }
  return { data: { page_count: merged.getPageCount(), was_protected: wasProtected }, outputs: [await merged.save()] };
}

async function copySelectedPages(source, pageNumbers) {
  const { PDFDocument } = await loadPdfLib();
  const target = await PDFDocument.create();
  for (const page of await target.copyPages(source, pageNumbers.map((pageNumber) => pageNumber - 1))) target.addPage(page);
  return target.save();
}

/**
 * Copies the selected pages, in the given order, into one new PDF.
 *
 * @param request - `{bytes, pages, maxPages, password}` (object)
 * @returns `{data: {pages, was_protected}, outputs: [Uint8Array]}` (object)
 */
export async function extractPdfPages({ bytes, pages, maxPages, password }) {
  const { document: source, wasProtected } = await loadPdfDocument(bytes, maxPages, { password, use: "assemble_pages" });
  const pageNumbers = parsePageSelection(pages, source.getPageCount());
  return { data: { pages: pageNumbers, was_protected: wasProtected }, outputs: [await copySelectedPages(source, pageNumbers)] };
}

/**
 * Splits into several PDFs: one per range, or one per `every` pages.
 *
 * @param request - `{bytes, ranges, every, maxPages, password}` (object)
 * @returns `{data: {parts: [{pages}], was_protected}, outputs: Uint8Array[]}` (object)
 */
export async function splitPdf({ bytes, ranges, every, maxPages, password }) {
  const { document: source, wasProtected } = await loadPdfDocument(bytes, maxPages, { password, use: "assemble_pages" });
  const pageCount = source.getPageCount();
  const parts = ranges?.length ? ranges.map((range, index) => parsePageSelection(range, pageCount, `ranges[${index}]`)) : chunkPages(pageCount, every ?? 1);
  if (parts.length > MAX_SPLIT_OUTPUTS) throw invalidInput(`Splitting would write ${parts.length} files, over the limit of ${MAX_SPLIT_OUTPUTS}`);
  const outputs = [];
  for (const pageNumbers of parts) outputs.push(await copySelectedPages(source, pageNumbers));
  return { data: { parts: parts.map((pageNumbers) => ({ pages: pageNumbers })), was_protected: wasProtected }, outputs };
}

function chunkPages(pageCount, chunkSize) {
  const chunks = [];
  for (let first = 1; first <= pageCount; first += chunkSize) chunks.push(Array.from({ length: Math.min(chunkSize, pageCount - first + 1) }, (_, index) => first + index));
  return chunks;
}

/**
 * Rotates selected pages by a multiple of 90 degrees (added to their current rotation).
 *
 * @param request - `{bytes, degrees, pages, maxPages, password}` (object)
 * @returns `{data: {rotated_pages, was_protected}, outputs: [Uint8Array]}` (object)
 */
export async function rotatePdfPages({ bytes, degrees, pages, maxPages, password }) {
  const { degrees: toDegrees } = await loadPdfLib();
  const { document, wasProtected } = await loadPdfDocument(bytes, maxPages, { password, use: "assemble_pages" });
  const pageNumbers = parsePageSelection(pages, document.getPageCount());
  for (const pageNumber of pageNumbers) {
    const page = document.getPage(pageNumber - 1);
    page.setRotation(toDegrees((((page.getRotation().angle + degrees) % 360) + 360) % 360));
  }
  return { data: { rotated_pages: pageNumbers, was_protected: wasProtected }, outputs: [await document.save()] };
}

/**
 * Draws a text watermark on selected pages with Helvetica.
 *
 * @param request - `{bytes, text, fontSize, opacity, angle, color, placement, pages, maxPages, password}`; color is [r, g, b] 0-1 (object)
 * @returns `{data: {watermarked_pages, was_protected}, outputs: [Uint8Array]}` (object)
 */
export async function watermarkPdf({ bytes, text, fontSize, opacity, angle, color, placement, pages, maxPages, password }) {
  const { StandardFonts, degrees: toDegrees, rgb } = await loadPdfLib();
  const { document, wasProtected } = await loadPdfDocument(bytes, maxPages, { password, use: "change_pages" });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const textWidth = measureText(font, text, fontSize);
  const pageNumbers = parsePageSelection(pages, document.getPageCount());
  for (const pageNumber of pageNumbers) {
    const page = document.getPage(pageNumber - 1);
    const { x, y } = placeWatermark(placement, { width: page.getWidth(), height: page.getHeight() }, { width: textWidth, height: fontSize }, angle);
    page.drawText(text, { x, y, size: fontSize, font, color: rgb(...color), opacity, rotate: toDegrees(angle) });
  }
  return { data: { watermarked_pages: pageNumbers, was_protected: wasProtected }, outputs: [await document.save()] };
}

// Helvetica (WinAnsi) cannot encode every character; say so instead of failing obscurely.
function measureText(font, text, fontSize) {
  try {
    return font.widthOfTextAtSize(text, fontSize);
  } catch (encodeError) {
    throw invalidInput(`\`text\` has characters the built-in Helvetica font cannot draw (Latin-1 only): ${encodeError.message}`);
  }
}

/**
 * Where to start drawing so the (rotated) text is centred horizontally at the chosen height.
 *
 * @param placement - "center", "top" or "bottom" (string)
 * @param page - `{width, height}` in points (object)
 * @param textBox - `{width, height}` of the unrotated text (object)
 * @param angle - Rotation in degrees (number)
 * @returns `{x, y}` in points (object)
 */
export function placeWatermark(placement, page, textBox, angle) {
  const radians = (angle * Math.PI) / 180;
  const centerY = placement === "top" ? page.height * 0.85 : placement === "bottom" ? page.height * 0.15 : page.height / 2;
  const halfWidth = textBox.width / 2;
  const halfHeight = textBox.height / 2;
  return {
    x: page.width / 2 - halfWidth * Math.cos(radians) + halfHeight * Math.sin(radians),
    y: centerY - halfWidth * Math.sin(radians) - halfHeight * Math.cos(radians),
  };
}

/**
 * Builds a PDF with one image per page.
 *
 * @param request - `{images: [{bytes, format}], pageSize, margin}`; format "jpeg" or "png", pageSize "fit", "a4" or "letter" (object)
 * @returns `{data: {page_count}, outputs: [Uint8Array]}` (object)
 */
export async function imagesToPdf({ images, pageSize, margin }) {
  const { PDFDocument } = await loadPdfLib();
  const document = await PDFDocument.create();
  for (const [index, image] of images.entries()) {
    const embedded = await (image.format === "png" ? document.embedPng(image.bytes) : document.embedJpg(image.bytes)).catch((embedError) => {
      throw invalidInput(`images[${index}] could not be embedded: ${embedError.message}`);
    });
    addImagePage(document, embedded, pageSize, margin);
  }
  return { data: { page_count: document.getPageCount() }, outputs: [await document.save()] };
}

function addImagePage(document, embedded, pageSize, margin) {
  if (pageSize === "fit") {
    const page = document.addPage([embedded.width + margin * 2, embedded.height + margin * 2]);
    page.drawImage(embedded, { x: margin, y: margin, width: embedded.width, height: embedded.height });
    return;
  }
  const [portraitWidth, portraitHeight] = PAGE_SIZES[pageSize];
  const [pageWidth, pageHeight] = embedded.width > embedded.height ? [portraitHeight, portraitWidth] : [portraitWidth, portraitHeight];
  const scale = Math.min((pageWidth - margin * 2) / embedded.width, (pageHeight - margin * 2) / embedded.height, 1);
  const page = document.addPage([pageWidth, pageHeight]);
  const drawWidth = embedded.width * scale;
  const drawHeight = embedded.height * scale;
  page.drawImage(embedded, { x: (pageWidth - drawWidth) / 2, y: (pageHeight - drawHeight) / 2, width: drawWidth, height: drawHeight });
}

/** Task name → engine function, for the worker. */
export const ENGINE_TASKS = {
  inspect: inspectPdf,
  extract_text: extractPdfText,
  merge: mergePdfs,
  extract_pages: extractPdfPages,
  split: splitPdf,
  rotate: rotatePdfPages,
  watermark: watermarkPdf,
  images_to_pdf: imagesToPdf,
};

/**
 * Runs one engine task by name.
 *
 * @param taskName - Key of ENGINE_TASKS (string)
 * @param payload - Task request (object)
 * @returns `{data, outputs?}` (object)
 * @throws PluginError kind `plugin_error` - For an unknown task
 */
export async function runEngineTask(taskName, payload) {
  const task = ENGINE_TASKS[taskName];
  if (!task) throw operationFailed(`Unknown PDF task ${taskName}`);
  return task(payload);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function toIsoDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}
