/**
 * Letter-spaced text that still reads as words.
 *
 * pdfkit draws `characterSpacing` with the PDF operator `Tc`: every glyph
 * keeps its own width and a gap follows it. Programs that read text back out
 * of a PDF (copy and paste, search, screen readers) take a wide gap for a
 * space, so the label TOTAL DUE came out as "T O T A L D U E".
 *
 * Here the same spacing is written as part of each glyph's width instead: the
 * text is drawn with a second copy of the font whose width table (`/W`) is
 * wider by the spacing, and without `Tc`. Every glyph lands on the same spot,
 * but no gap is left between one glyph's end and the next one's start, so
 * readers see whole words. Only widened text (spacing above 0) is drawn this
 * way; tightened text never read as separate letters.
 *
 * This reaches into pdfkit's font objects. When they do not look as expected
 * (another pdfkit version), text is drawn the old way with `Tc`; the look is
 * the same either way, and test/text-extraction.test.mjs fails.
 */

// One font copy per font, size and spacing; a template has a handful. Past the cap, text falls back to `Tc`.
const MAX_TRACKED_FONTS = 32;
const WIDTH_PRECISION = 1000;
const INSTALLED = Symbol("document-templates tracked text");
const trackedFontsByDocument = new WeakMap();

/**
 * Makes a pdfkit document class draw widened `characterSpacing` as glyph widths.
 * Safe to call more than once.
 *
 * @param DocumentClass - pdfmake's PDFDocument class, a subclass of pdfkit's (function)
 * @returns true when the class draws tracked text this way, false when pdfkit's internals are not as expected (boolean)
 */
export function installTrackedText(DocumentClass) {
  const prototype = DocumentClass?.prototype;
  if (typeof prototype?._fragment !== "function") return false;
  if (Object.hasOwn(prototype, INSTALLED)) return true;
  const drawFragment = prototype._fragment;
  prototype._fragment = function drawTrackedFragment(text, x, y, options) {
    const trackedFont = provideTrackedFont(this, options);
    if (!trackedFont) return drawFragment.call(this, text, x, y, options);
    const font = this._font;
    this._font = trackedFont;
    try {
      return drawFragment.call(this, text, x, y, { ...options, characterSpacing: 0 });
    } finally {
      this._font = font;
    }
  };
  prototype[INSTALLED] = true;
  return true;
}

function provideTrackedFont(document, options) {
  const spacing = options?.characterSpacing;
  const font = document._font;
  if (!(spacing > 0) || !(document._fontSize > 0) || (options.horizontalScaling ?? 100) !== 100 || !isEmbeddedFont(font, document)) return null;
  // Glyph widths are in thousandths of the font size.
  const extraWidth = Math.round(((spacing * 1000) / document._fontSize) * WIDTH_PRECISION) / WIDTH_PRECISION;
  const trackedFonts = trackedFontsByDocument.get(document) ?? new Map();
  trackedFontsByDocument.set(document, trackedFonts);
  const key = `${font.id}:${extraWidth}`;
  if (!trackedFonts.has(key)) {
    if (trackedFonts.size >= MAX_TRACKED_FONTS) return null;
    const trackedFont = createTrackedFont(document, font, extraWidth);
    trackedFonts.set(key, trackedFont);
    // pdfkit embeds every font listed here when the document ends.
    document._fontFamilies[`tracked:${key}`] = trackedFont;
  }
  return trackedFonts.get(key);
}

function isEmbeddedFont(font, document) {
  return Boolean(font?.subset) && Array.isArray(font.widths) && typeof font.layoutRun === "function" && typeof font.encode === "function" && Number.isInteger(document._fontCount) && typeof document._fontFamilies === "object";
}

// A second pdfkit font over the same parsed font file, with its own glyph subset and a wider width table.
function createTrackedFont(document, font, extraWidth) {
  document._fontCount += 1;
  const trackedFont = new font.constructor(document, font.font, `F${document._fontCount}`);
  const layoutRun = trackedFont.layoutRun;
  const encode = trackedFont.encode;
  trackedFont.layoutRun = function layoutTrackedRun(text, features) {
    const run = layoutRun.call(this, text, features);
    for (const position of run.positions) {
      position.xAdvance += extraWidth;
      position.advanceWidth += extraWidth;
    }
    return run;
  };
  trackedFont.encode = function encodeTracked(text, features) {
    const [glyphCodes, positions] = encode.call(this, text, features);
    glyphCodes.forEach((glyphCode, index) => {
      this.widths[Number.parseInt(glyphCode, 16)] = positions[index].advanceWidth;
    });
    return [glyphCodes, positions];
  };
  return trackedFont;
}
