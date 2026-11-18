/**
 * Plain text to Notion rich text and paragraph blocks.
 *
 * Notion limits each rich text `text.content` to 2000 characters and each rich text array to 100 items, so
 * long text is cut into several rich text objects (never inside a UTF-16 surrogate pair).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const MAX_TEXT_CONTENT_LENGTH = 2000;
export const MAX_RICH_TEXT_ITEMS = 100;
// Notion caps a request payload at 500KB (developers.notion.com/reference/request-limits). 400,000 characters of
// paragraph text leaves room for the JSON around it; text that is mostly multi-byte can still exceed 500KB.
export const MAX_PARAGRAPHS_TOTAL_LENGTH = 400000;

/**
 * Splits plain text into rich text objects of at most 2000 characters each.
 *
 * @param plainText - Text to convert; "" gives [] (string)
 * @param fieldLabel - Name used in error messages (string, optional)
 * @returns Rich text array `[{type: "text", text: {content}}]` (Array<object>)
 * @throws PluginError kind `invalid_input` - When the text needs more than 100 rich text objects
 *
 * @example
 * splitIntoRichText("Hello"); // [{ type: "text", text: { content: "Hello" } }]
 */
export function splitIntoRichText(plainText, fieldLabel = "text") {
  const chunks = [];
  for (let start = 0; start < plainText.length; ) {
    let end = Math.min(start + MAX_TEXT_CONTENT_LENGTH, plainText.length);
    if (end < plainText.length && isHighSurrogate(plainText.charCodeAt(end - 1))) end -= 1;
    chunks.push(plainText.slice(start, end));
    start = end;
  }
  if (chunks.length > MAX_RICH_TEXT_ITEMS) {
    const maxLength = MAX_RICH_TEXT_ITEMS * MAX_TEXT_CONTENT_LENGTH;
    throw new PluginError(`\`${fieldLabel}\` is too long: Notion accepts at most ${maxLength} characters here`, { kind: "invalid_input" });
  }
  return chunks.map((content) => ({ type: "text", text: { content } }));
}

/**
 * Turns strings into paragraph blocks, one block per string.
 *
 * @param paragraphs - Paragraph texts (string[])
 * @returns Notion paragraph block objects (Array<object>)
 * @throws PluginError kind `invalid_input` - Paragraphs longer than 400,000 characters in total, or one too long
 */
export function buildParagraphBlocks(paragraphs) {
  assertParagraphsFitOneRequest(paragraphs);
  return paragraphs.map((paragraphText, index) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: splitIntoRichText(String(paragraphText), `paragraphs[${index}]`) },
  }));
}

function assertParagraphsFitOneRequest(paragraphs) {
  const totalLength = paragraphs.reduce((sum, paragraphText) => sum + String(paragraphText).length, 0);
  if (totalLength <= MAX_PARAGRAPHS_TOTAL_LENGTH) return;
  throw new PluginError(
    `\`paragraphs\` total ${totalLength} characters; send at most ${MAX_PARAGRAPHS_TOTAL_LENGTH} characters per call (Notion's request limit is 500KB) and append the rest with another append_paragraphs call`,
    { kind: "invalid_input" },
  );
}

function isHighSurrogate(charCode) {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}
