/**
 * Pure parsing helpers: turn raw values read from the WhatsApp Web DOM (by
 * lib/dom-probes.mjs) into plugin output, and classify browser failures.
 * No browser access here, so everything is unit-tested with sample data.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { invalidInput } from "./errors.mjs";

const PHONE_FORMATTING_PATTERN = /[\s\-().]/g;
const INTERNATIONAL_DIGITS_PATTERN = /^[1-9]\d{6,14}$/;
const PRE_PLAIN_TEXT_PATTERN = /^\[(.+?)\]\s?(.*?):\s?$/s;
const UNREAD_COUNT_PATTERN = /(\d+)/;

/**
 * Normalises a phone number to the international digits WhatsApp uses (E.164 without "+").
 *
 * @param rawPhoneNumber - Number such as "+62 812-3456-789" (string)
 * @returns Digits only, country code first, e.g. "628123456789" (string)
 * @throws PluginError kind `invalid_input` - When it is not 7–15 digits starting with a country code
 */
export function normalizePhoneNumber(rawPhoneNumber) {
  const digits = String(rawPhoneNumber ?? "").replace(PHONE_FORMATTING_PATTERN, "").replace(/^\+/, "");
  if (!INTERNATIONAL_DIGITS_PATTERN.test(digits)) {
    throw invalidInput(
      `\`phone\` must be an international number with country code (7–15 digits, e.g. "+62 812 3456 789"), got ${JSON.stringify(rawPhoneNumber)}`,
    );
  }
  return digits;
}

/**
 * Splits a message bubble's `data-id` ("<fromMe>_<chatJid>_<messageId>[_<participantJid>]").
 *
 * @param dataId - Value of the `data-id` attribute (string)
 * @returns `{from_me, chat_id, id, participant}` or null when it is not a message id (object | null)
 */
export function parseMessageDataId(dataId) {
  const parts = String(dataId ?? "").split("_");
  if (parts.length < 3 || (parts[0] !== "true" && parts[0] !== "false")) return null;
  const [fromMeFlag, chatId, messageId, ...participantParts] = parts;
  if (!chatId.includes("@") || !messageId) return null;
  return {
    from_me: fromMeFlag === "true",
    chat_id: chatId,
    id: messageId,
    participant: participantParts.length ? participantParts.join("_") : null,
  };
}

/**
 * Reads time and sender from `data-pre-plain-text`, e.g. "[10:42, 18/11/2026] Alice: ".
 * The time keeps WhatsApp's own (locale-dependent) format.
 *
 * @param prePlainText - Attribute value (string | null)
 * @returns `{time, sender}` with nulls when absent (object)
 */
export function parsePrePlainText(prePlainText) {
  const match = PRE_PLAIN_TEXT_PATTERN.exec(String(prePlainText ?? ""));
  if (!match) return { time: null, sender: null };
  return { time: match[1].trim(), sender: match[2].trim() || null };
}

/**
 * Derives the delivery state of an outgoing message from its status icon.
 *
 * @param iconNames - `data-icon` names found in the bubble (string[])
 * @param iconLabels - `aria-label`s of those icons (string[])
 * @returns "pending" | "sent" | "delivered" | "read", or null when there is no status icon
 */
export function parseDeliveryStatus(iconNames = [], iconLabels = []) {
  const statusIcon = iconNames.find((iconName) => /(^|-)(time|check|dblcheck)$/.test(iconName));
  if (!statusIcon) return null;
  if (statusIcon.endsWith("time")) return "pending";
  if (statusIcon.endsWith("dblcheck")) return iconLabels.some((label) => /read/i.test(label)) ? "read" : "delivered";
  return "sent";
}

/**
 * Turns raw message rows into messages: drops non-message rows, dedupes by id, keeps the last `limit`.
 *
 * @param rawRows - Rows `{dataId, prePlainText, text, iconNames, iconLabels}` in page order (Array<object>)
 * @param limit - Maximum number of messages to keep, newest last (number)
 * @returns Messages `{id, from_me, sender, time, text, status, chat_id, participant}` (Array<object>)
 */
export function parseMessageRows(rawRows, limit) {
  const messagesById = new Map();
  for (const rawRow of rawRows) {
    const identity = parseMessageDataId(rawRow.dataId);
    if (!identity || messagesById.has(identity.id)) continue;
    const { time, sender } = parsePrePlainText(rawRow.prePlainText);
    messagesById.set(identity.id, {
      id: identity.id,
      from_me: identity.from_me,
      sender,
      time,
      text: rawRow.text ? rawRow.text : null,
      status: identity.from_me ? parseDeliveryStatus(rawRow.iconNames, rawRow.iconLabels) : null,
      chat_id: identity.chat_id,
      participant: identity.participant,
    });
  }
  return [...messagesById.values()].slice(-limit);
}

/**
 * Finds the newest outgoing message that was not on screen before sending.
 *
 * @param rawRows - Message rows read after sending (Array<object>)
 * @param knownMessageIds - Ids present before sending (Set<string>)
 * @returns The new outgoing message, or null (object | null)
 */
export function findNewOutgoingMessage(rawRows, knownMessageIds) {
  const newOutgoing = parseMessageRows(rawRows, Infinity).filter((message) => message.from_me && !knownMessageIds.has(message.id));
  return newOutgoing.at(-1) ?? null;
}

/**
 * Turns raw chat-list rows into chats, ordered top to bottom.
 *
 * @param rawRows - Rows `{top, title, text, unreadLabel}` (Array<object>)
 * @returns Chats `{name, time, last_message, unread_count}` (Array<object>)
 */
export function parseChatRows(rawRows) {
  return [...rawRows]
    .sort((firstRow, secondRow) => firstRow.top - secondRow.top)
    .map(parseChatRow)
    .filter((chat) => chat.name);
}

function parseChatRow(rawRow) {
  const lines = String(rawRow.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const name = (rawRow.title || lines[0] || "").trim();
  const unreadCount = parseUnreadCount(rawRow.unreadLabel);
  const detailLines = lines[0] === name ? lines.slice(1) : lines;
  const previewLines = detailLines.slice(1);
  if (unreadCount > 0 && previewLines.at(-1) === String(unreadCount)) previewLines.pop();
  return { name, time: detailLines[0] ?? null, last_message: previewLines.join(" ") || null, unread_count: unreadCount };
}

function parseUnreadCount(unreadLabel) {
  const match = UNREAD_COUNT_PATTERN.exec(String(unreadLabel ?? ""));
  return match ? Number(match[1]) : 0;
}

/**
 * Appends chats from a new scroll position, keeping the first sighting of each name.
 *
 * @param knownChats - Chats collected so far (Array<object>)
 * @param newChats - Chats read after scrolling (Array<object>)
 * @returns New merged array (Array<object>)
 */
export function mergeChatRows(knownChats, newChats) {
  const knownNames = new Set(knownChats.map((chat) => chat.name));
  return [...knownChats, ...newChats.filter((chat) => !knownNames.has(chat.name))];
}

/**
 * Decides the login state from what is on screen. The chat list wins over a stale QR canvas.
 *
 * @param signals - `{hasChatList, hasQrCode}` from probeLoginSignals (object | null)
 * @returns "logged_in" | "needs_login" | "loading"
 */
export function determineLoginStatus(signals) {
  if (signals?.hasChatList) return "logged_in";
  if (signals?.hasQrCode) return "needs_login";
  return "loading";
}

/**
 * Tells whether WhatsApp Web shows its "update your browser" page instead of the app.
 *
 * @param pageTextStart - Start of the page's visible text (string | null)
 * @returns true for the unsupported-browser page (boolean)
 */
export function isUnsupportedBrowserPage(pageTextStart) {
  return /works with Google Chrome|update (Google )?Chrome/i.test(String(pageTextStart ?? ""));
}

/**
 * Builds a regular desktop Chrome user agent for a Chromium version.
 * Headless Chromium says "HeadlessChrome", which WhatsApp Web rejects as an unsupported browser.
 *
 * @param browserVersion - e.g. "159.0.8154.6" (string)
 * @param platform - Node `process.platform` (string)
 * @returns User agent string (string)
 */
export function buildDesktopUserAgent(browserVersion, platform) {
  const platformTokens = {
    darwin: "Macintosh; Intel Mac OS X 10_15_7",
    win32: "Windows NT 10.0; Win64; x64",
  };
  const platformToken = platformTokens[platform] ?? "X11; Linux x86_64";
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;
}

/**
 * Maps a Playwright launch failure to a clear plugin error.
 *
 * @param launchError - Error thrown by launchPersistentContext (Error)
 * @returns PluginError kind `setup_required` (no Chromium) or `browser_error`
 */
export function classifyLaunchError(launchError) {
  const message = String(launchError?.message ?? launchError);
  if (/Executable doesn't exist|Cannot find module 'playwright'|ERR_MODULE_NOT_FOUND/i.test(message)) {
    return new PluginError(
      "Playwright or its Chromium is not installed. Run `npm install && npx playwright install chromium` in the whatsapp-web plugin directory.",
      { kind: "setup_required" },
    );
  }
  if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/i.test(message)) {
    return new PluginError(
      "The WhatsApp Web browser profile is in use by another browser process. Close it (or wait for the other run to finish) and retry.",
      { kind: "browser_error" },
    );
  }
  return new PluginError(`Failed to start the browser: ${message.split("\n")[0]}`, { kind: "browser_error" });
}
