/**
 * Parameter schemas and argument helpers shared by the email operations.
 */
import { assertSingleLine } from "../lib/addresses.mjs";
import { invalidInput } from "../lib/errors.mjs";

export const MAX_UIDS_PER_CALL = 100;

export const MAILBOX_PROPERTY = {
  type: "string",
  default: "INBOX",
  description: "Mailbox (folder) path as shown by list_mailboxes, e.g. INBOX or \"[Gmail]/Sent Mail\"",
};

export const UIDS_PROPERTY = {
  type: "string",
  description: `Message UID, or several separated by commas (at most ${MAX_UIDS_PER_CALL}), from list_messages`,
};

/**
 * Validates a mailbox path.
 *
 * @param fieldName - Argument name (string)
 * @param mailboxPath - Path such as "INBOX" (string)
 * @returns Trimmed path (string)
 * @throws PluginError kind `invalid_input` - When empty, too long or with control characters
 */
export function validateMailboxPath(fieldName, mailboxPath) {
  const trimmed = String(mailboxPath ?? "").trim();
  if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalidInput(`\`${fieldName}\` must be a mailbox path of 1-512 characters without control characters`);
  }
  return trimmed;
}

/**
 * Parses "12, 15,16" into unique positive UIDs.
 *
 * @param rawUids - Comma-separated UIDs (string)
 * @returns `[12, 15, 16]` (number[])
 * @throws PluginError kind `invalid_input` - When a UID is not a positive integer or there are too many
 */
export function parseUidList(rawUids) {
  const entries = String(rawUids ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw invalidInput("`uids` must list at least one message UID");
  if (entries.length > MAX_UIDS_PER_CALL) throw invalidInput(`\`uids\` may list at most ${MAX_UIDS_PER_CALL} UIDs`);
  const uids = entries.map((entry) => {
    if (!/^\d{1,10}$/.test(entry) || Number(entry) < 1 || Number(entry) > 4294967295) throw invalidInput(`\`uids\`: ${JSON.stringify(entry)} is not a message UID`);
    return Number(entry);
  });
  return [...new Set(uids)];
}

/**
 * Validates an optional single-line search text.
 *
 * @param fieldName - Argument name (string)
 * @param value - Text or undefined (string | undefined)
 * @returns Trimmed text or undefined (string | undefined)
 * @throws PluginError kind `invalid_input` - On line breaks or more than 200 characters
 */
export function validateSearchText(fieldName, value) {
  if (value === undefined) return undefined;
  const trimmed = assertSingleLine(fieldName, String(value)).trim();
  if (trimmed.length > 200) throw invalidInput(`\`${fieldName}\` must be at most 200 characters`);
  return trimmed || undefined;
}

/**
 * Parses a `since` date (YYYY-MM-DD or an ISO timestamp).
 *
 * @param value - Date text (string | undefined)
 * @returns Date or undefined (Date | undefined)
 * @throws PluginError kind `invalid_input` - When not a date
 */
export function parseSinceDate(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? new Date(`${trimmed}T00:00:00Z`) : new Date(trimmed);
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed) || Number.isNaN(date.getTime())) throw invalidInput("`since` must be a date such as 2026-11-01");
  return date;
}
