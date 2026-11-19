/**
 * Pure helpers for watermarks: the text SVG (XML-escaped, no external
 * references) and where an overlay goes for a position and margin.
 */
import { invalidInput } from "./errors.mjs";

export const POSITIONS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
const AVERAGE_GLYPH_WIDTH = 0.6;
const LINE_HEIGHT = 1.3;

/**
 * Checks a colour given as #rgb or #rrggbb.
 *
 * @param color - Colour text (string)
 * @returns Lower-case #rrggbb (string)
 * @throws PluginError kind `invalid_input` - When the colour is not a hex colour
 */
export function normalizeHexColor(color) {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!match) throw invalidInput("`color` must be a hex colour such as #ffffff or #fff");
  const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return `#${hex.toLowerCase()}`;
}

/**
 * Escapes text for an SVG text node.
 *
 * @param text - Any text (string)
 * @returns Escaped text with control characters removed (string)
 */
export function escapeXml(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Builds an SVG holding one line of text, sized to fit inside the image.
 *
 * @param options - `{text, fontSize, color, opacity, maxWidth, maxHeight}` (object)
 * @returns `{svg, width, height}` (object)
 */
export function buildTextSvg({ text, fontSize, color, opacity, maxWidth, maxHeight }) {
  const width = Math.max(1, Math.min(maxWidth, Math.ceil(text.length * fontSize * AVERAGE_GLYPH_WIDTH) + 4));
  const height = Math.max(1, Math.min(maxHeight, Math.ceil(fontSize * LINE_HEIGHT)));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<text x="2" y="${Math.round(fontSize)}" font-family="sans-serif" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity}">${escapeXml(text)}</text>`,
    "</svg>",
  ].join("");
  return { svg, width, height };
}

/**
 * Computes the top-left corner of an overlay for a position and margin, kept inside the base image.
 *
 * @param position - One of POSITIONS (string)
 * @param base - `{width, height}` of the image (object)
 * @param overlay - `{width, height}` of the overlay (object)
 * @param margin - Distance from the edges in pixels (number)
 * @returns `{left, top}` (object)
 *
 * @example
 * computeOverlayPosition("bottom-right", { width: 100, height: 50 }, { width: 20, height: 10 }, 5); // { left: 75, top: 35 }
 */
export function computeOverlayPosition(position, base, overlay, margin) {
  const horizontal = position.endsWith("left") ? "start" : position.endsWith("right") ? "end" : "middle";
  const vertical = position.startsWith("top") ? "start" : position.startsWith("bottom") ? "end" : "middle";
  return {
    left: placeAlong(horizontal, base.width, overlay.width, margin),
    top: placeAlong(vertical, base.height, overlay.height, margin),
  };
}

function placeAlong(alignment, baseLength, overlayLength, margin) {
  const room = Math.max(0, baseLength - overlayLength);
  const offset = alignment === "start" ? margin : alignment === "end" ? room - margin : room / 2;
  return Math.round(Math.min(room, Math.max(0, offset)));
}
