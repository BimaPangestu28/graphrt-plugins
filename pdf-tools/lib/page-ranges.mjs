/**
 * Parses page selections such as "1-3,5,8-" against a document's page count.
 */
import { invalidInput } from "./errors.mjs";

const RANGE_PATTERN = /^(\d+)?\s*(-)?\s*(\d+)?$/;

/**
 * Turns a page selection into 1-based page numbers, in the order given.
 *
 * @param selection - e.g. "1-3,5,8-" or "all"; undefined means all pages (string, optional)
 * @param pageCount - Pages in the document (number)
 * @param parameterName - For messages (string)
 * @returns Page numbers, duplicates removed (number[])
 * @throws PluginError kind `invalid_input` - When the selection is malformed or outside the document
 *
 * @example
 * parsePageSelection("2-3,1", 5, "pages"); // [2, 3, 1]
 */
export function parsePageSelection(selection, pageCount, parameterName = "pages") {
  if (selection === undefined || String(selection).trim().toLowerCase() === "all") return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pageNumbers = [];
  for (const part of String(selection).split(",")) {
    const [first, last] = parseRange(part.trim(), pageCount, parameterName);
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) pageNumbers.push(pageNumber);
  }
  if (pageNumbers.length === 0) throw invalidInput(`\`${parameterName}\` selects no pages`);
  return [...new Set(pageNumbers)];
}

function parseRange(part, pageCount, parameterName) {
  const match = RANGE_PATTERN.exec(part);
  if (!part || !match || (!match[1] && !match[3])) throw invalidInput(`\`${parameterName}\`: ${JSON.stringify(part)} is not a page or range like 3 or 2-5`);
  const first = match[1] ? Number(match[1]) : 1;
  const last = match[2] ? (match[3] ? Number(match[3]) : pageCount) : first;
  if (first < 1 || last > pageCount || first > last) {
    throw invalidInput(`\`${parameterName}\`: ${JSON.stringify(part)} is outside pages 1-${pageCount}`);
  }
  return [first, last];
}
