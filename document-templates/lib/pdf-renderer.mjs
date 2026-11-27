/**
 * Draws a render plan (see layout-template.mjs) as a PDF with pdfmake, a
 * pure JavaScript layout engine on pdfkit and fontkit: no browser, no office
 * suite, the same output on every platform.
 *
 * It runs inside the worker process. pdfmake is told to refuse every local
 * path and every URL; fonts and images reach it as bytes only. An optional
 * background PDF (a letterhead) is placed under every page with pdf-lib.
 */
import { invalidInput, operationFailed } from "./errors.mjs";
import { assertAllCharactersDrawable, buildFontTable, loadFonts, splitByFont } from "./fonts.mjs";
import { PAGE_COUNT_MARKER, PAGE_NUMBER_MARKER } from "./layout-template.mjs";

const DEFAULT_FONT = "sans";
const DEFAULT_MARGINS = [48, 48, 48, 64];
// Tabular figures: Inter's default kerning pulls "1." and "7." together until 1.277.000 reads as 1.277000.
const DEFAULT_FONT_FEATURES = ["tnum"];
const BOTTOM_NODE_ID = "document-templates-bottom";
const END_NODE_ID = "document-templates-end";
const LAYOUT_DEFAULTS = { lines: "none", line_width: 0.5, line_color: "#D9D9D9", padding: [0, 4, 0, 4], column_gap: 0 };
const BLOCK_CHILD_KEYS = ["stack", "columns", "ul", "ol"];

/**
 * Renders a plan to PDF bytes.
 *
 * @param request - `{plan, images: Uint8Array[], backgroundPdf: Uint8Array | null, extraFontPaths: string[], maxPages}` (object)
 * @returns `{data: {page_count}, outputs: [Uint8Array]}` (object)
 * @throws PluginError kind `invalid_input` - When the plan names an unknown font, uses characters no font has, or exceeds the page cap
 */
export async function renderLayoutPdf({ plan, images, backgroundPdf, extraFontPaths, maxPages }) {
  const fonts = await loadFonts(extraFontPaths);
  const pdfmake = await createPdfEngine(fonts);
  const builder = { plan, fonts, images: images.map((bytes) => Buffer.from(bytes)), hasBackgroundPdf: Boolean(backgroundPdf) };
  let rendered = await renderOnce(pdfmake, builder, 0);
  if (plan.bottom && rendered.bottomGap > 1) {
    // Second pass: the measured gap under the bottom block becomes space above it, pinning it to the page's foot.
    const pinned = await renderOnce(pdfmake, builder, rendered.bottomGap - 0.5);
    if (pinned.pageCount === rendered.pageCount) rendered = pinned;
  }
  if (rendered.pageCount > maxPages) throw invalidInput(`The document has ${rendered.pageCount} pages, over the ${maxPages}-page limit (DOCUMENT_TEMPLATES_MAX_PAGES)`);
  const bytes = backgroundPdf ? await placeOnBackground(rendered.bytes, backgroundPdf, plan.info) : rendered.bytes;
  return { data: { page_count: rendered.pageCount }, outputs: [bytes] };
}

async function createPdfEngine(fonts) {
  const { default: pdfmake } = await import("pdfmake");
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  for (const [fileName, bytes] of Object.entries(fonts.files)) pdfmake.sharedVirtualfs.writeFileSync(fileName, bytes);
  pdfmake.setFonts(buildFontTable(fonts.families));
  return pdfmake;
}

async function renderOnce(pdfmake, builder, bottomSpace) {
  const measured = { pageCount: 0, bottomTop: null, bottomPage: null, endTop: null, endPage: null, pageHeight: 0, marginBottom: 0 };
  const definition = buildDocumentDefinition(builder, bottomSpace, measured);
  const bytes = await pdfmake.createPdf(definition).getBuffer().catch((renderError) => {
    throw renderError?.kind ? renderError : operationFailed(`The document could not be drawn: ${renderError?.message ?? renderError}`);
  });
  const isBottomOnOnePage = measured.endPage !== null && measured.endPage === measured.bottomPage;
  const bottomGap = isBottomOnOnePage ? measured.pageHeight - measured.marginBottom - measured.endTop : 0;
  return { bytes, pageCount: measured.pageCount, bottomGap };
}

function buildDocumentDefinition({ plan, fonts, images, hasBackgroundPdf }, bottomSpace, measured) {
  const defaultStyle = { font: DEFAULT_FONT, fontSize: 10, fontFeatures: DEFAULT_FONT_FEATURES, ...plan.defaultStyle };
  const missing = new Set();
  const context = { fonts, styles: plan.styles, missing, imageNames: images.map((_bytes, index) => `image-${index}`) };
  assertKnownFonts([defaultStyle, ...Object.values(plan.styles)], fonts);
  const pageMargins = plan.page.margins ?? DEFAULT_MARGINS;
  const content = plan.content.map((node) => buildNode(node, defaultStyle.font, context));
  if (plan.bottom) {
    content.push({ stack: [buildNode(plan.bottom, defaultStyle.font, context)], unbreakable: true, id: BOTTOM_NODE_ID, margin: [0, bottomSpace, 0, 0] });
    content.push({ text: " ", fontSize: 0.1, lineHeight: 0.1, id: END_NODE_ID });
  }
  const pageSection = (section) => (currentPage, pageCount) => {
    measured.pageCount = Math.max(measured.pageCount, pageCount);
    return section ? buildNode(withPageNumbers(section, currentPage, pageCount), defaultStyle.font, context) : null;
  };
  const definition = {
    pageSize: plan.page.size ?? "A4",
    pageOrientation: plan.page.orientation ?? "portrait",
    pageMargins,
    defaultStyle,
    styles: plan.styles,
    images: Object.fromEntries(images.map((bytes, index) => [context.imageNames[index], bytes])),
    info: { ...plan.info, creator: "graphrt document-templates", producer: "graphrt document-templates (pdfmake)" },
    content,
    header: pageSection(plan.header),
    footer: pageSection(plan.footer),
    pageBreakBefore: (node) => {
      recordPosition(node, measured, pageMargins);
      return false;
    },
  };
  if (plan.page.background_color && !hasBackgroundPdf) {
    definition.background = (_currentPage, pageSize) => ({ canvas: [{ type: "rect", x: 0, y: 0, w: pageSize.width, h: pageSize.height, color: plan.page.background_color }] });
  }
  if (plan.watermark) definition.watermark = buildWatermark(plan.watermark, defaultStyle.font, context);
  assertAllCharactersDrawable(missing);
  return definition;
}

// A watermark is one text in one font: when the default font lacks its characters, the whole text moves to the font that has them.
function buildWatermark(watermark, defaultFont, context) {
  const runs = fallbackFreeText(watermark.text, defaultFont, context);
  const fallbackFont = typeof runs === "string" ? undefined : runs.find((run) => run.font)?.font;
  return { ...watermark, font: fallbackFont ?? defaultFont };
}

function recordPosition(node, measured, pageMargins) {
  if (node.id === BOTTOM_NODE_ID && node.startPosition) {
    measured.bottomTop = node.startPosition.top;
    measured.bottomPage = node.startPosition.pageNumber;
  }
  if (node.id === END_NODE_ID && node.startPosition) {
    measured.endTop = node.startPosition.top;
    measured.endPage = node.startPosition.pageNumber;
    measured.pageHeight = node.startPosition.pageInnerHeight + pageMargins[1] + pageMargins[3];
    measured.marginBottom = pageMargins[3];
  }
}

function assertKnownFonts(styles, fonts) {
  for (const style of styles) {
    if (style.font !== undefined && !fonts.families[style.font]) throw unknownFont(style.font, fonts);
  }
}

function unknownFont(fontName, fonts) {
  return invalidInput(`The template uses the font ${JSON.stringify(fontName)}; available fonts: ${Object.keys(fonts.families).join(", ")}`);
}

// A header or footer is drawn once per page; its page markers are filled in here.
function withPageNumbers(section, currentPage, pageCount) {
  return JSON.parse(JSON.stringify(section).replaceAll(PAGE_NUMBER_MARKER, String(currentPage)).replaceAll(PAGE_COUNT_MARKER, String(pageCount)));
}

/**
 * Converts one plan node into a pdfmake node: resolves its font, splits text
 * into font runs, and turns `layout`, `rule` and `image` into what pdfmake draws.
 */
function buildNode(planNode, inheritedFont, context) {
  const font = resolveFont(planNode, inheritedFont, context);
  const node = { ...planNode };
  if (planNode.text !== undefined) node.text = buildText(planNode.text, font, context);
  for (const key of BLOCK_CHILD_KEYS) {
    if (planNode[key]) node[key] = planNode[key].map((child) => buildNode(child, font, context));
  }
  if (planNode.table) return buildTable(node, planNode, font, context);
  if (planNode.rule) return buildRule(planNode);
  if (planNode.image !== undefined) node.image = context.imageNames[planNode.image];
  return node;
}

function buildTable(node, planNode, font, context) {
  if (planNode.table.body.length === 0) return { text: "" };
  node.table = { ...planNode.table, body: planNode.table.body.map((row) => row.map((cell) => buildNode(cell, font, context))) };
  node.layout = buildTableLayout(planNode.layout);
  return node;
}

function resolveFont(planNode, inheritedFont, context) {
  const styleNames = planNode.style === undefined ? [] : [planNode.style].flat();
  const styleFont = styleNames.map((name) => context.styles[name]?.font).filter(Boolean).pop();
  const font = planNode.font ?? styleFont ?? inheritedFont;
  if (!context.fonts.families[font]) throw unknownFont(font, context.fonts);
  return font;
}

function buildText(text, font, context) {
  if (typeof text === "string") return fallbackFreeText(text, font, context);
  return text.map((inline) => {
    if (typeof inline === "string") return wrapRuns(splitByFont(inline, font, context.fonts.families, context.missing));
    const inlineFont = resolveFont(inline, font, context);
    return { ...inline, text: buildText(inline.text, inlineFont, context) };
  });
}

function fallbackFreeText(text, font, context) {
  return splitByFont(text.replaceAll(PAGE_NUMBER_MARKER, "").replaceAll(PAGE_COUNT_MARKER, ""), font, context.fonts.families, context.missing);
}

function wrapRuns(runs) {
  return typeof runs === "string" ? runs : { text: runs };
}

function buildRule(planNode) {
  const { color = "#D9D9D9", thickness = 0.5, margin = [0, 8, 0, 8] } = planNode.rule;
  return { table: { widths: ["*"], body: [[{ text: "", fontSize: 0.1, lineHeight: 0.1 }]] }, margin, layout: { hLineWidth: (lineIndex) => (lineIndex === 0 ? thickness : 0), vLineWidth: () => 0, hLineColor: () => color, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 } };
}

/**
 * Turns the declarative table layout into pdfmake's per-line functions.
 *
 * @param layout - `{lines, line_width, line_color, header_line_width, header_line_color, padding, column_gap}` (object, optional)
 * @returns pdfmake table layout (object)
 */
export function buildTableLayout(layout = {}) {
  const settings = { ...LAYOUT_DEFAULTS, ...layout };
  const [paddingLeft, paddingTop, paddingRight, paddingBottom] = typeof settings.padding === "number" ? Array(4).fill(settings.padding) : settings.padding;
  const headerWidth = settings.header_line_width ?? settings.line_width;
  const headerColor = settings.header_line_color ?? settings.line_color;
  const isHeaderLine = (lineIndex, node) => (node.table.headerRows ?? 0) > 0 && lineIndex === node.table.headerRows;
  const horizontalWidth = (lineIndex, node) => {
    if (settings.lines === "none") return 0;
    if (isHeaderLine(lineIndex, node)) return headerWidth;
    if (settings.lines === "header") return 0;
    if (settings.lines === "rows") return lineIndex === 0 ? 0 : settings.line_width;
    return settings.line_width;
  };
  return {
    hLineWidth: horizontalWidth,
    vLineWidth: () => (settings.lines === "grid" ? settings.line_width : 0),
    hLineColor: (lineIndex, node) => (isHeaderLine(lineIndex, node) ? headerColor : settings.line_color),
    vLineColor: () => settings.line_color,
    paddingLeft: (columnIndex) => paddingLeft + (columnIndex > 0 ? settings.column_gap / 2 : 0),
    paddingRight: (columnIndex, node) => paddingRight + (columnIndex < node.table.widths.length - 1 ? settings.column_gap / 2 : 0),
    paddingTop: () => paddingTop,
    paddingBottom: () => paddingBottom,
  };
}

// Draws each rendered page on top of the background PDF's page: page 1 on its first page, the others on its second (or first).
async function placeOnBackground(contentBytes, backgroundBytes, info) {
  const { PDFDocument } = await import("pdf-lib");
  const background = await PDFDocument.load(backgroundBytes, { updateMetadata: false, ignoreEncryption: true }).catch((loadError) => {
    throw invalidInput(`The background PDF is not readable: ${loadError.message}`);
  });
  if (background.isEncrypted) throw invalidInput("The background PDF is encrypted; save an unprotected copy first");
  if (background.getPageCount() === 0) throw invalidInput("The background PDF has no pages");
  const content = await PDFDocument.load(contentBytes, { updateMetadata: false });
  const output = await PDFDocument.create();
  const backgroundPages = await output.embedPdf(background, background.getPageCount() > 1 ? [0, 1] : [0]);
  const contentPages = await output.embedPdf(content, content.getPageIndices());
  contentPages.forEach((contentPage, pageIndex) => {
    const page = output.addPage([contentPage.width, contentPage.height]);
    const backgroundPage = backgroundPages[Math.min(pageIndex, backgroundPages.length - 1)];
    page.drawPage(backgroundPage, { x: 0, y: 0, width: contentPage.width, height: contentPage.height });
    page.drawPage(contentPage, { x: 0, y: 0 });
  });
  if (info.title) output.setTitle(info.title);
  if (info.author) output.setAuthor(info.author);
  if (info.subject) output.setSubject(info.subject);
  output.setCreator("graphrt document-templates");
  output.setProducer("graphrt document-templates (pdfmake, pdf-lib)");
  return output.save();
}
