/**
 * Validation for everything that ends up in a mail header: addresses,
 * display names, subjects and Message-IDs.
 *
 * Header injection is blocked at the source: any CR, LF or NUL in a
 * header-bound value is refused (nodemailer would encode most of them, but
 * refusing keeps an LLM from smuggling extra headers or recipients in).
 * Addresses are parsed here, not by nodemailer, so only plain
 * `addr@domain` and `Name <addr@domain>` forms are accepted.
 */
import { invalidInput } from "./errors.mjs";

const LINE_BREAK_PATTERN = /[\r\n\0\u2028\u2029]/;
const LOCAL_PART_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_PATTERN = /^[\p{L}\p{N}]([\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
// No whitespace, quotes, brackets, C0 controls or DEL anywhere in the id.
const MESSAGE_ID_PATTERN = /^<[^<>\s"\u0000-\u001f\u007f]{1,994}@[^<>\s"\u0000-\u001f\u007f]{1,253}>$/;
const MAX_ADDRESS_LENGTH = 254;
const MAX_NAME_LENGTH = 200;

/**
 * Refuses values that could start a new header line.
 *
 * @param fieldName - Argument name for the error message (string)
 * @param value - Value bound for a header (string)
 * @returns The value unchanged (string)
 * @throws PluginError kind `invalid_input` - When it contains CR, LF, NUL or a Unicode line separator
 */
export function assertSingleLine(fieldName, value) {
  if (LINE_BREAK_PATTERN.test(value)) throw invalidInput(`\`${fieldName}\` must not contain line breaks`);
  return value;
}

/**
 * Tells whether a bare address (no display name) is acceptable.
 *
 * @param address - e.g. "budi@example.co.id" (string)
 * @returns true when valid (boolean)
 */
export function isValidEmailAddress(address) {
  if (typeof address !== "string" || address.length > MAX_ADDRESS_LENGTH) return false;
  const atIndex = address.lastIndexOf("@");
  if (atIndex < 1) return false;
  const localPart = address.slice(0, atIndex);
  const domainLabels = address.slice(atIndex + 1).split(".");
  return (
    localPart.length <= 64 &&
    LOCAL_PART_PATTERN.test(localPart) &&
    domainLabels.length >= 2 &&
    domainLabels.every((label) => DOMAIN_LABEL_PATTERN.test(label)) &&
    !/^\d+$/.test(domainLabels.at(-1))
  );
}

/**
 * Parses a comma- or semicolon-separated address list.
 *
 * @param fieldName - Argument name for error messages (string)
 * @param rawList - e.g. `budi@x.com, "Sari W" <sari@y.com>` (string)
 * @returns `[{name, address}]` with `name` "" when there is none (object[])
 * @throws PluginError kind `invalid_input` - On line breaks, group syntax or an invalid address
 *
 * @example
 * parseAddressList("to", "Budi <budi@example.com>; sari@example.com");
 * // [{ name: "Budi", address: "budi@example.com" }, { name: "", address: "sari@example.com" }]
 */
export function parseAddressList(fieldName, rawList) {
  if (rawList === undefined || rawList === null || String(rawList).trim() === "") return [];
  assertSingleLine(fieldName, String(rawList));
  return splitAddressList(String(rawList))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseMailbox(fieldName, entry));
}

/**
 * Normalises one Message-ID (adds the angle brackets when missing).
 *
 * @param fieldName - Argument name for error messages (string)
 * @param rawMessageId - e.g. "<abc@mail.example.com>" (string)
 * @returns "<id@host>" (string)
 * @throws PluginError kind `invalid_input` - When it is not a Message-ID
 */
export function normalizeMessageId(fieldName, rawMessageId) {
  const trimmed = assertSingleLine(fieldName, String(rawMessageId)).trim();
  const bracketed = trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
  if (!MESSAGE_ID_PATTERN.test(bracketed)) throw invalidInput(`\`${fieldName}\` must be a Message-ID such as <id@mail.example.com>, got ${JSON.stringify(trimmed)}`);
  return bracketed;
}

/**
 * Normalises a whitespace-separated list of Message-IDs (the References header).
 *
 * @param fieldName - Argument name (string)
 * @param rawList - e.g. "<a@x> <b@x>" (string)
 * @returns `["<a@x>", "<b@x>"]` (string[])
 * @throws PluginError kind `invalid_input` - When an entry is not a Message-ID
 */
export function normalizeMessageIdList(fieldName, rawList) {
  assertSingleLine(fieldName, String(rawList));
  const entries = String(rawList).match(/<[^<>]*>|[^\s<>,]+/g) ?? [];
  if (entries.length > 100) throw invalidInput(`\`${fieldName}\` may hold at most 100 Message-IDs`);
  return entries.map((entry) => normalizeMessageId(fieldName, entry));
}

// Splits on , or ; that are not inside quotes or angle brackets.
function splitAddressList(listText) {
  const entries = [];
  let current = "";
  let isInQuotes = false;
  let angleDepth = 0;
  for (const character of listText) {
    if (character === '"') isInQuotes = !isInQuotes;
    else if (!isInQuotes && character === "<") angleDepth += 1;
    else if (!isInQuotes && character === ">") angleDepth = Math.max(0, angleDepth - 1);
    if ((character === "," || character === ";") && !isInQuotes && angleDepth === 0) {
      entries.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  entries.push(current);
  return entries;
}

function parseMailbox(fieldName, entry) {
  const angleMatch = /^(.*)<([^<>]*)>$/.exec(entry);
  const address = (angleMatch ? angleMatch[2] : entry).trim();
  const name = angleMatch ? cleanDisplayName(fieldName, angleMatch[1]) : "";
  if (/^[^<"]*:/.test(entry)) throw invalidInput(`\`${fieldName}\`: group syntax is not supported (${JSON.stringify(entry)})`);
  if (!isValidEmailAddress(address)) throw invalidInput(`\`${fieldName}\`: ${JSON.stringify(address)} is not a valid email address`);
  return { name, address };
}

function cleanDisplayName(fieldName, rawName) {
  const unquoted = rawName.trim().replace(/^"(.*)"$/, "$1").trim();
  if (/["<>\\]/.test(unquoted)) throw invalidInput(`\`${fieldName}\`: display name ${JSON.stringify(unquoted)} must not contain quotes, <, > or \\`);
  // A name such as "ceo@bank.example" shows as a different sender or recipient than the real address.
  if (unquoted.includes("@")) throw invalidInput(`\`${fieldName}\`: display name ${JSON.stringify(unquoted)} must not contain @ (it would look like an address)`);
  if (unquoted.length > MAX_NAME_LENGTH) throw invalidInput(`\`${fieldName}\`: display name is longer than ${MAX_NAME_LENGTH} characters`);
  return unquoted;
}
