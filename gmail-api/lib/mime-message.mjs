/**
 * Builds the RFC 5322 / MIME message that Gmail's `messages.send` and `drafts.create` take as base64url `raw`
 * (https://developers.google.com/workspace/gmail/api/guides/sending).
 *
 * Safety: every header value is checked or encoded, so no argument can add a header or a MIME part. Addresses must
 * be plain (lib/recipient-policy.mjs), the subject is refused if it holds line breaks and is RFC 2047 encoded when
 * it is not plain ASCII (folded into encoded-words of at most 75 characters on continuation lines), and Message-IDs for threading must look like `<id@host>`. Bodies are UTF-8 in base64
 * with 76-character lines. With both text and html the message is multipart/alternative; its boundary is derived
 * from the content (deterministic, and never valid base64, so it cannot occur inside a part).
 */
import { createHash } from "node:crypto";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { normalizeAddresses } from "./recipient-policy.mjs";

const MAX_SUBJECT_LENGTH = 900;
const MESSAGE_ID_LIST_PATTERN = /^<[^<>\s]+@[^<>\s]+>(\s+<[^<>\s]+@[^<>\s]+>)*$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const LINE_BREAK = /[\r\n\0]/;
// 42 UTF-8 bytes are 56 base64 characters: "=?UTF-8?B?" + 56 + "?=" is a 68-character encoded-word (RFC 2047
// allows 75), and "Subject: " + one word stays within 78 characters (RFC 5322).
const ENCODED_WORD_MAX_BYTES = 42;

/**
 * Builds the MIME message text.
 *
 * @param fields - `{to, cc, bcc, reply_to, subject, text, html, in_reply_to, references}` (object)
 * @returns `{mime, recipients}`: the message and every to/cc/bcc address (object)
 * @throws PluginError kind `invalid_input` - Bad address, subject, Message-ID, or no body
 *
 * @example
 * buildMimeMessage({ to: ["ada@example.com"], subject: "Hi", text: "Hello" }).mime;
 * // "To: ada@example.com\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n..."
 */
export function buildMimeMessage(fields) {
  const [to, cc, bcc, replyTo] = ["to", "cc", "bcc", "reply_to"].map((fieldName) => normalizeAddresses(fields[fieldName], fieldName));
  if (fields.text === undefined && fields.html === undefined) throw new PluginError("Give `text`, `html` or both", { kind: "invalid_input" });
  const headers = [
    ...addressHeader("To", to),
    ...addressHeader("Cc", cc),
    ...addressHeader("Bcc", bcc),
    ...addressHeader("Reply-To", replyTo),
    `Subject: ${encodeSubject(fields.subject ?? "")}`,
    ...messageIdHeader("In-Reply-To", fields.in_reply_to),
    ...messageIdHeader("References", fields.references ?? fields.in_reply_to),
    "MIME-Version: 1.0",
  ];
  return { mime: [...headers, ...buildBody(fields.text, fields.html)].join("\r\n"), recipients: [...to, ...cc, ...bcc] };
}

/**
 * Encodes a MIME message as Gmail's `raw` (base64url, no padding).
 *
 * @param mime - Message text (string)
 * @returns base64url text (string)
 */
export function encodeRawMessage(mime) {
  return Buffer.from(mime, "utf8").toString("base64url");
}

function addressHeader(headerName, addresses) {
  return addresses.length > 0 ? [`${headerName}: ${addresses.join(", ")}`] : [];
}

function encodeSubject(subject) {
  const subjectText = String(subject);
  if (LINE_BREAK.test(subjectText)) throw new PluginError("`subject` must not contain line breaks", { kind: "invalid_input" });
  if (subjectText.length > MAX_SUBJECT_LENGTH) throw new PluginError(`\`subject\` is longer than ${MAX_SUBJECT_LENGTH} characters`, { kind: "invalid_input" });
  if (PRINTABLE_ASCII.test(subjectText)) return subjectText;
  return splitIntoUtf8Chunks(subjectText, ENCODED_WORD_MAX_BYTES)
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`)
    .join("\r\n ");
}

// Splits on code point boundaries, so no character is cut across two encoded-words (RFC 2047 section 5).
function splitIntoUtf8Chunks(text, maxBytes) {
  const chunks = [""];
  for (const character of text) {
    const current = chunks[chunks.length - 1];
    if (Buffer.byteLength(current + character, "utf8") > maxBytes) chunks.push(character);
    else chunks[chunks.length - 1] = current + character;
  }
  return chunks;
}

function messageIdHeader(headerName, messageIds) {
  if (messageIds === undefined || messageIds === "") return [];
  const value = String(messageIds).trim();
  if (!MESSAGE_ID_LIST_PATTERN.test(value)) throw new PluginError(`\`${headerName === "In-Reply-To" ? "in_reply_to" : "references"}\` must be Message-IDs like <abc@mail.example.com>`, { kind: "invalid_input" });
  return [`${headerName}: ${value}`];
}

function buildBody(text, html) {
  if (text === undefined || html === undefined) return [...encodedPartHeaders(html === undefined ? "text/plain" : "text/html"), "", encodeBase64Lines(text ?? html)];
  const boundary = `graphrt-alt-${createHash("sha256").update(`${text}\u0000${html}`).digest("hex").slice(0, 24)}`;
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...encodedPartHeaders("text/plain"),
    "",
    encodeBase64Lines(text),
    `--${boundary}`,
    ...encodedPartHeaders("text/html"),
    "",
    encodeBase64Lines(html),
    `--${boundary}--`,
  ];
}

function encodedPartHeaders(mediaType) {
  return [`Content-Type: ${mediaType}; charset=UTF-8`, "Content-Transfer-Encoding: base64"];
}

function encodeBase64Lines(content) {
  return Buffer.from(String(content), "utf8").toString("base64").replace(/.{76}(?=.)/g, "$&\r\n");
}
