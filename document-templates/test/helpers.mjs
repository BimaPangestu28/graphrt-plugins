/**
 * Test helpers: temp directories, a runner over the real definition (engine
 * tasks run in this process unless a test asks for the real worker), and
 * generated fixtures (a fillable PDF, a Word template, a PNG). No binary
 * fixtures are committed. Library-backed tests skip without `npm install`.
 */
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";
import { runEngineTask } from "../lib/document-engine.mjs";

export const AS_TOOL = { source: "tool" };
export const AS_NODE = { source: "node" };
export const pdfLib = await import("pdf-lib").catch(() => null);
const PizZip = await import("pizzip").then((module) => module.default, () => null);
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => null);
const hasRenderer = await import("pdfmake").then(() => true, () => false);
const hasDocx = await import("docxtemplater").then(() => true, () => false);
export const SKIP_WITHOUT_LIBRARIES = pdfLib && PizZip && pdfjs && hasRenderer && hasDocx ? false : "npm packages are not installed (run npm install in document-templates)";
/** The moment every test runs at: 27 November 2026, local time. */
export const FIXED_NOW = new Date(2026, 10, 27, 9, 30, 15);

/** Fictional invoice values used across the tests. */
export const INVOICE_VALUES = Object.freeze({
  number: "INV-2026-0007",
  date: "2026-11-27",
  due_date: "2026-12-11",
  currency: "IDR",
  language: "id",
  seller: { name: "CV Kenanga Digital", address: ["Jalan Kenanga 12", "Bandung 40115"] },
  client: { name: "PT Maju Bersama", address: "Jalan Merdeka 45\nJakarta 10110" },
  items: [
    { description: "Desain antarmuka", quantity: 2, unit: "hari", unit_price: 1500000 },
    { description: "Pengembangan", quantity: "3.5", unit: "hari", unit_price: "2000000" },
  ],
  taxes: [{ name: "PPN", rate: 11 }],
});

/**
 * Creates temp directories and an operation runner for them.
 *
 * @param options - `{environment, runTask, dependencies}`; runTask defaults to the engine in this process (object)
 * @param work - `async ({runOperation, inputDirectory, outputDirectory, outsideDirectory}) => void` (function)
 * @returns Promise of work's result
 */
export async function withDocumentRunner({ environment = {}, runTask = (task, payload) => runEngineTask(task, structuredClone(payload)), dependencies = {} } = {}, work) {
  const baseDirectory = await realpath(await mkdtemp(join(tmpdir(), "graphrt-document-test-")));
  const directories = { inputDirectory: join(baseDirectory, "in"), outputDirectory: join(baseDirectory, "out"), outsideDirectory: join(baseDirectory, "outside") };
  for (const directory of Object.values(directories)) await mkdir(directory);
  const runOperation = createOperationRunner(createPluginDefinition({ runTask, now: () => FIXED_NOW, ...dependencies }), {
    DOCUMENT_TEMPLATES_INPUT_DIRS: directories.inputDirectory,
    DOCUMENT_TEMPLATES_OUTPUT_DIR: directories.outputDirectory,
    ...environment,
  });
  try {
    return await work({ runOperation, ...directories });
  } finally {
    await rm(baseDirectory, { recursive: true, force: true });
  }
}

/**
 * Reads the text of every page of a PDF with pdfjs-dist.
 *
 * @param bytes - PDF bytes (Uint8Array)
 * @returns One text per page, items joined by spaces; letter-spaced labels come back as "T O T A L" (string[])
 */
export async function readPageTexts(bytes) {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const pdf = await loadingTask.promise;
    const texts = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      texts.push(content.items.map((item) => item.str).join(" ").replace(/\s+/g, " "));
    }
    return texts;
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Builds a fillable PDF: text fields InvoiceNo, Client, Total and Notes, and a check box Paid.
 *
 * @returns PDF bytes (Uint8Array)
 */
export async function buildFormPdf() {
  const document = await pdfLib.PDFDocument.create();
  const page = document.addPage([400, 300]);
  const form = document.getForm();
  ["InvoiceNo", "Client", "Total", "Notes"].forEach((fieldName, index) => {
    form.createTextField(fieldName).addToPage(page, { x: 120, y: 240 - index * 40, width: 240, height: 22 });
  });
  form.createCheckBox("Paid").addToPage(page, { x: 120, y: 60, width: 16, height: 16 });
  return document.save();
}

/**
 * Builds a PDF with plain pages and no form.
 *
 * @param pageCount - Number of A4 pages (number, default 1)
 * @returns PDF bytes (Uint8Array)
 */
export async function buildPlainPdf(pageCount = 1) {
  const document = await pdfLib.PDFDocument.create();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) document.addPage([595.28, 841.89]).drawText(`Letterhead page ${pageNumber}`, { x: 40, y: 800, size: 10 });
  return document.save();
}

const DOCX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const DOCX_RELATIONSHIPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

function paragraph(text) {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
}

function tableRow(cells) {
  return `<w:tr>${cells.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join("")}</w:tr>`;
}

/**
 * Builds a minimal Word document.
 *
 * @param options - `{paragraphs, rows, extraFiles}`: body paragraphs, table rows (arrays of cell texts), extra zip entries (object)
 * @returns .docx bytes (Buffer)
 */
export function buildDocx({ paragraphs = [], rows = [], extraFiles = {} } = {}) {
  const table = rows.length > 0 ? `<w:tbl>${rows.map(tableRow).join("")}</w:tbl>` : "";
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(paragraph).join("")}${table}<w:sectPr/></w:body></w:document>`;
  const zip = new PizZip();
  zip.file("[Content_Types].xml", DOCX_CONTENT_TYPES);
  zip.file("_rels/.rels", DOCX_RELATIONSHIPS);
  zip.file("word/document.xml", documentXml);
  for (const [entryName, content] of Object.entries(extraFiles)) zip.file(entryName, content);
  return zip.generate({ type: "nodebuffer" });
}

/**
 * Reads the visible text of a .docx file's paragraphs.
 *
 * @param bytes - .docx bytes (Buffer)
 * @returns One text per paragraph (string[])
 */
export function readDocxParagraphs(bytes) {
  const documentXml = new PizZip(bytes).file("word/document.xml").asText();
  const decode = (text) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  return [...documentXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)].map((match) => decode([...match[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:br\/>/g)].map((run) => run[1] ?? "\n").join("")));
}

/**
 * Builds a solid-colour PNG.
 *
 * @param width - Pixels (number)
 * @param height - Pixels (number)
 * @returns PNG bytes (Buffer)
 */
export function buildPng(width = 8, height = 4) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
