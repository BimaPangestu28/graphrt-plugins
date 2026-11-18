/**
 * WhatsApp Web page actions on a Playwright page: login detection, opening a
 * chat, reading the chat list and messages, sending text and files.
 *
 * DOM reads go through lib/dom-probes.mjs and are interpreted by lib/parse.mjs;
 * selectors live in lib/selectors.mjs. Waiting is done by polling probes
 * (`pollProbe`), so behaviour does not depend on a single selector appearing.
 * Every step is wrapped in `runStep` so failures name the step (`browser_error`).
 */
import { basename } from "node:path";
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { browserError, cancelled, invalidInput, notFound, notLoggedIn, runStep } from "./errors.mjs";
import {
  probeChatRows,
  probeConversationState,
  probeCountChatsNamed,
  probeEditableText,
  probeLoginSignals,
  probeMarkFilePreview,
  probeMessageRows,
  probeScrollChatList,
  probeScrollMessagesUp,
} from "./dom-probes.mjs";
import {
  determineLoginStatus,
  findMismatchedChatId,
  findNewOutgoingMessage,
  isSameEditableText,
  isUnsupportedBrowserPage,
  mergeRawChatRows,
  parseChatRows,
  parseMessageRows,
} from "./parse.mjs";
import { INVALID_PHONE_POPUP_PATTERN, SELECTORS, WHATSAPP_WEB_URL, buildSendToPhoneUrl } from "./selectors.mjs";

export const POLL_INTERVAL_MS = 500;
// Page loads wait for the HTML only (the app renders afterwards); slow links can still take tens of seconds.
const NAVIGATION_OPTIONS = { waitUntil: "domcontentloaded", timeout: 60000 };
const APP_LOAD_ATTEMPTS = 120; // 60 s: first load of a big account is slow
const CHAT_OPEN_ATTEMPTS = 60; // 30 s
const SEARCH_ATTEMPTS = 8; // 4 s for search results
const MESSAGE_WAIT_ATTEMPTS = 10; // 5 s; an empty chat has no bubbles at all
const SETTLE_ATTEMPTS = 10; // 5 s for the bubbles on screen to stop changing
const EMPTY_SETTLE_ATTEMPTS = 4; // an empty conversation is trusted after 2 s
const PREVIEW_ATTEMPTS = 60; // 30 s for the file preview to show
const MAX_SHOWN_EDITOR_TEXT = 60;
const SEND_CONFIRM_ATTEMPTS = 60; // 30 s for the bubble to appear
const UPLOAD_CONFIRM_ATTEMPTS = 240; // 120 s for a file upload
const DELIVERY_ATTEMPTS = 30; // 15 s for the clock icon to turn into a tick
export const LOGIN_SETTLE_MS = 8000; // let the first sync write the session before the window closes
const SCROLL_SETTLE_MS = 600;
const MAX_CHAT_SCROLLS = 40;
const MAX_MESSAGE_SCROLLS = 10;
const FILE_PREVIEW_REQUEST = {
  captionBox: SELECTORS.composer.captionBox,
  container: SELECTORS.composer.previewContainer,
  sendButton: SELECTORS.composer.previewSendButton,
  excludedArea: SELECTORS.composer.previewExcludedArea,
};
const CONVERSATION_STATE_SELECTORS = {
  messageBox: SELECTORS.composer.messageBox,
  popup: SELECTORS.dialogs.popup,
  qrCode: SELECTORS.login.qrCode,
  headerTitle: SELECTORS.conversation.headerTitle,
};

/**
 * Evaluates `probe` until `isDone(result)` or `maxAttempts` polls, POLL_INTERVAL_MS apart.
 *
 * @returns The last probe result (Promise<any>)
 */
export async function pollProbe(page, probe, probeArgument, isDone, maxAttempts) {
  let lastResult;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    lastResult = await page.evaluate(probe, probeArgument);
    if (isDone(lastResult)) return lastResult;
    if (attempt < maxAttempts - 1) await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return lastResult;
}

/**
 * Opens WhatsApp Web if needed and reports the login state.
 *
 * @param page - Playwright page (Page)
 * @returns "logged_in" | "needs_login" | "loading" (still loading after 60 s) (Promise<string>)
 */
export async function readLoginStatus(page) {
  await runStep("open WhatsApp Web", async () => {
    if (!page.url().startsWith(WHATSAPP_WEB_URL)) await page.goto(WHATSAPP_WEB_URL, NAVIGATION_OPTIONS);
  });
  const isSettled = (loginSignals) => determineLoginStatus(loginSignals) !== "loading" || isUnsupportedBrowserPage(loginSignals.pageTextStart);
  const signals = await runStep("detect login state", () => pollProbe(page, probeLoginSignals, SELECTORS.login, isSettled, APP_LOAD_ATTEMPTS));
  const loginStatus = determineLoginStatus(signals);
  if (loginStatus === "loading" && isUnsupportedBrowserPage(signals?.pageTextStart)) {
    throw browserError("load WhatsApp Web", "WhatsApp Web rejected the browser as unsupported (check the user agent / update Playwright)");
  }
  return loginStatus;
}

/**
 * Fails fast unless the chat list is showing.
 *
 * @throws PluginError kinds `auth_error` (QR screen), `browser_error` (never finished loading)
 */
export async function assertLoggedIn(page) {
  const loginStatus = await readLoginStatus(page);
  if (loginStatus === "needs_login") throw notLoggedIn();
  if (loginStatus === "loading") throw browserError("load WhatsApp Web", "neither the chat list nor the QR code appeared within 60 s");
}

/**
 * Waits (in a visible window) until the user has scanned the QR code.
 *
 * @param options.timeoutMs - Budget for loading WhatsApp Web plus the scan; the 8 s settle comes on top (number)
 * @param options.now - Clock, injectable for tests (() => number, optional)
 * @returns `{status: "logged_in", already_logged_in}` (Promise<object>)
 * @throws PluginError kind `auth_error` - When the QR code was not scanned in time
 */
export async function waitForLogin(page, { timeoutMs, now = Date.now }) {
  const deadlineMs = now() + timeoutMs;
  if ((await readLoginStatus(page)) === "logged_in") return { status: "logged_in", already_logged_in: true };
  const remainingMs = Math.max(deadlineMs - now(), POLL_INTERVAL_MS);
  console.error(`[whatsapp-web] waiting up to ${Math.round(remainingMs / 1000)} s for the QR code to be scanned`);
  const maxAttempts = Math.ceil(remainingMs / POLL_INTERVAL_MS);
  const signals = await runStep("wait for QR scan", () => pollProbe(page, probeLoginSignals, SELECTORS.login, (loginSignals) => loginSignals.hasChatList, maxAttempts));
  if (!signals?.hasChatList) {
    throw new PluginError(`The QR code was not scanned within ${Math.round(timeoutMs / 1000)} s; run the login node again`, { kind: "auth_error" });
  }
  await page.waitForTimeout(LOGIN_SETTLE_MS);
  return { status: "logged_in", already_logged_in: false };
}

/**
 * Opens a conversation by phone number or by exact chat name, and verifies it is the right one:
 * by phone, every message on screen must belong to `<digits>@...`; by name, exactly one chat
 * may carry the name and the header must show it.
 *
 * @param target - `{phone}` (digits) or `{name}` (object)
 * @returns `{chat_name}` as shown in the conversation header (Promise<object>)
 * @throws PluginError kinds `auth_error`, `not_found`, `invalid_input` (name shared by several chats),
 *   `browser_error` (including a conversation that belongs to another number)
 */
export async function openChat(page, target) {
  return target.phone ? openChatByPhone(page, target.phone) : openChatByName(page, target.name);
}

async function openChatByPhone(page, phoneDigits) {
  await runStep("open chat by phone", () => page.goto(buildSendToPhoneUrl(phoneDigits), NAVIGATION_OPTIONS));
  const isSettled = (state) => state.hasMessageBox || state.hasQrCode || INVALID_PHONE_POPUP_PATTERN.test(state.popupText ?? "");
  const state = await runStep("wait for chat", () => pollProbe(page, probeConversationState, CONVERSATION_STATE_SELECTORS, isSettled, APP_LOAD_ATTEMPTS));
  if (state.hasMessageBox) {
    await assertChatBelongsToPhone(page, phoneDigits);
    return { chat_name: state.headerTitle };
  }
  if (state.hasQrCode) throw notLoggedIn();
  if (INVALID_PHONE_POPUP_PATTERN.test(state.popupText ?? "")) throw notFound(`+${phoneDigits} is not on WhatsApp (${state.popupText.trim()})`);
  throw browserError("open chat by phone", "the conversation did not open within 60 s");
}

// Click-to-chat can leave another conversation on screen; its bubbles carry the chat JID.
async function assertChatBelongsToPhone(page, phoneDigits) {
  const foreignChatId = findMismatchedChatId(await readSettledMessageRows(page), phoneDigits);
  if (foreignChatId) {
    throw browserError("verify chat", `the open conversation belongs to ${foreignChatId}, not +${phoneDigits}; refusing to use it (nothing was sent)`);
  }
}

async function openChatByName(page, chatName) {
  await assertLoggedIn(page);
  await runStep("search chat", () => page.locator(SELECTORS.search.input).first().fill(chatName));
  const matchingChatCount = await countChatsNamed(page, chatName);
  if (matchingChatCount !== 1) {
    await clearSearch(page);
    if (matchingChatCount > 1) {
      throw invalidInput(`${matchingChatCount} chats are named ${JSON.stringify(chatName)}; pass \`phone\` (with country code) to choose one`);
    }
    throw notFound(`No chat named ${JSON.stringify(chatName)} (the name must match exactly as shown in WhatsApp); use \`phone\` for numbers`);
  }
  await runStep("open chat", () => page.locator(SELECTORS.chatList.pane).getByTitle(chatName, { exact: true }).first().click());
  // The header must show this chat, so a previously open chat is never mistaken for it.
  const isOpen = (state) => state.hasMessageBox && state.headerTitle === chatName;
  const state = await runStep("wait for chat", () => pollProbe(page, probeConversationState, CONVERSATION_STATE_SELECTORS, isOpen, CHAT_OPEN_ATTEMPTS));
  if (!isOpen(state)) throw browserError("open chat", `the conversation header shows ${JSON.stringify(state.headerTitle)}, not ${JSON.stringify(chatName)}`);
  return { chat_name: chatName };
}

// Search results appear progressively: once one row matches, read again so a second match is not missed.
async function countChatsNamed(page, chatName) {
  const lookup = { rowSelector: SELECTORS.chatList.row, titleSelector: SELECTORS.chatList.rowTitle, name: chatName };
  const firstCount = await runStep("find chat", () => pollProbe(page, probeCountChatsNamed, lookup, (count) => count > 0, SEARCH_ATTEMPTS));
  if (!firstCount) return 0;
  await page.waitForTimeout(POLL_INTERVAL_MS);
  const secondCount = await runStep("find chat", () => page.evaluate(probeCountChatsNamed, lookup));
  return Math.max(firstCount, secondCount);
}

async function clearSearch(page) {
  const searchBox = page.locator(SELECTORS.search.input).first();
  if ((await searchBox.count()) > 0) await searchBox.fill("");
}

/**
 * Reads the chat list from the top, scrolling until `limit` chats (matching `unreadOnly`) are found.
 *
 * @returns Chats `{name, time, last_message, unread_count}` (Promise<Array<object>>)
 */
export async function listChats(page, { limit, unreadOnly }) {
  await assertLoggedIn(page);
  await runStep("clear search", () => clearSearch(page));
  const scrollRequest = { paneSelector: SELECTORS.chatList.pane, toTop: true };
  await runStep("scroll chat list", () => page.evaluate(probeScrollChatList, scrollRequest));
  const keepChat = (chat) => !unreadOnly || chat.unread_count > 0;
  let rawRows = [];
  let chats = [];
  for (let scrollCount = 0; scrollCount < MAX_CHAT_SCROLLS; scrollCount += 1) {
    rawRows = mergeRawChatRows(rawRows, await runStep("read chat list", () => page.evaluate(probeChatRows, SELECTORS.chatList)));
    chats = parseChatRows(rawRows);
    if (chats.filter(keepChat).length >= limit) break;
    const { moved } = await runStep("scroll chat list", () => page.evaluate(probeScrollChatList, { ...scrollRequest, toTop: false }));
    if (!moved) break;
    await page.waitForTimeout(SCROLL_SETTLE_MS);
  }
  return chats.filter(keepChat).slice(0, limit);
}

/**
 * Types `query` into the WhatsApp search box and reads the matching rows.
 *
 * @returns Rows `{name, time, last_message, unread_count}` (Promise<Array<object>>)
 */
export async function searchChats(page, { query, limit }) {
  await assertLoggedIn(page);
  await runStep("search chats", () => page.locator(SELECTORS.search.input).first().fill(query));
  await page.waitForTimeout(SEARCH_ATTEMPTS * POLL_INTERVAL_MS);
  const rawRows = await runStep("read search results", () => page.evaluate(probeChatRows, SELECTORS.chatList));
  await runStep("clear search", () => clearSearch(page));
  return parseChatRows(rawRows).slice(0, limit);
}

/**
 * Reads the last `limit` messages of the open conversation, scrolling up for older ones.
 *
 * @returns Messages, oldest first (Promise<Array<object>>)
 */
export async function readMessages(page, { limit }) {
  const hasRows = (rawRows) => rawRows.length > 0;
  let rawRows = await runStep("read messages", () => pollProbe(page, probeMessageRows, SELECTORS.conversation, hasRows, MESSAGE_WAIT_ATTEMPTS));
  for (let scrollCount = 0; parseMessageRows(rawRows, limit).length < limit && scrollCount < MAX_MESSAGE_SCROLLS; scrollCount += 1) {
    const { moved } = await runStep("load older messages", () => page.evaluate(probeScrollMessagesUp, SELECTORS.conversation));
    if (!moved) break;
    await page.waitForTimeout(SCROLL_SETTLE_MS);
    rawRows = await runStep("read messages", () => page.evaluate(probeMessageRows, SELECTORS.conversation));
  }
  return parseMessageRows(rawRows, limit);
}

/**
 * Types and sends a text message in the open conversation, then confirms it appears.
 * Any draft left in the message box is cleared first, and the box is checked to hold
 * exactly `text` right before Enter (see assertSafeToSend).
 *
 * @param options.text - Message text (string)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @returns The sent message `{id, from_me, time, text, status, ...}` (Promise<object>)
 * @throws PluginError kinds `browser_error` (a step failed, the box held other text, or the message never appeared), `cancelled`
 */
export async function sendText(page, { text, signal }) {
  const knownMessageIds = await readKnownMessageIds(page);
  await replaceEditorText(page, SELECTORS.composer.messageBox, text);
  await assertSafeToSend(page, { signal, editorSelector: SELECTORS.composer.messageBox, intendedText: text });
  await runStep("press Enter", () => page.keyboard.press("Enter"));
  return confirmSent(page, { knownMessageIds, expectedContent: { text }, maxAttempts: SEND_CONFIRM_ATTEMPTS });
}

/**
 * Attaches a local file (as media or document) with an optional caption and sends it
 * with the preview's own send button.
 *
 * @param options.filePath - Local file (string)
 * @param options.caption - Caption text (string, optional)
 * @param options.asDocument - Use the document input instead of photos & videos (boolean)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @returns The sent message (Promise<object>)
 * @throws PluginError kinds `browser_error`, `cancelled`
 */
export async function sendFile(page, { filePath, caption = "", asDocument, signal }) {
  const knownMessageIds = await readKnownMessageIds(page);
  await runStep("open attach menu", () => page.locator(SELECTORS.composer.attachButton).first().click());
  const inputSelector = asDocument ? SELECTORS.composer.documentFileInput : SELECTORS.composer.mediaFileInput;
  await runStep("attach file", () => page.locator(inputSelector).first().setInputFiles(filePath));
  const { hasCaptionBox } = await waitForFilePreview(page);
  if (!hasCaptionBox && caption) throw browserError("type caption", "the file preview has no caption box; nothing was sent");
  const captionSelector = hasCaptionBox ? SELECTORS.composer.markedPreviewCaption : null;
  // WhatsApp carries a draft from the message box into the caption, so the caption box is always replaced.
  if (captionSelector) await replaceEditorText(page, captionSelector, caption);
  await assertSafeToSend(page, { signal, editorSelector: captionSelector, intendedText: caption });
  await runStep("send file", () => page.locator(SELECTORS.composer.markedPreviewSendButton).first().click());
  const expectedContent = { caption, fileName: basename(filePath) };
  return confirmSent(page, { knownMessageIds, expectedContent, maxAttempts: UPLOAD_CONFIRM_ATTEMPTS });
}

/**
 * The point of no return, called immediately before pressing Enter / clicking send:
 * fails with `cancelled` if the run was cancelled, and with a non-retryable
 * `browser_error` unless the editor holds exactly the intended text (whitespace aside).
 *
 * @param page - Playwright page (Page)
 * @param options.signal - Cancellation signal (AbortSignal, optional)
 * @param options.editorSelector - Editor to check, or null when there is none (no caption box) (string | null)
 * @param options.intendedText - Text that must be in the editor (string)
 * @throws PluginError kinds `cancelled`, `browser_error` - Nothing has been sent when it throws
 */
export async function assertSafeToSend(page, { signal, editorSelector, intendedText }) {
  if (signal?.aborted) throw cancelled();
  if (editorSelector) {
    const editorText = await runStep("check text before sending", () => page.evaluate(probeEditableText, editorSelector));
    if (!isSameEditableText(editorText, intendedText)) {
      const shownText = editorText === null ? "no text box" : JSON.stringify(editorText.slice(0, MAX_SHOWN_EDITOR_TEXT));
      throw browserError("check text before sending", `the text box shows ${shownText} instead of the intended text; nothing was sent`);
    }
  }
  if (signal?.aborted) throw cancelled();
}

async function replaceEditorText(page, editorSelector, text) {
  await runStep("focus text box", () => page.locator(editorSelector).first().click());
  await runStep("clear text box", async () => {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
  });
  if (text) await runStep("type text", () => typeMultilineText(page, text));
}

async function waitForFilePreview(page) {
  const isShowing = (preview) => preview.found;
  const preview = await runStep("wait for file preview", () => pollProbe(page, probeMarkFilePreview, FILE_PREVIEW_REQUEST, isShowing, PREVIEW_ATTEMPTS));
  if (!preview?.found) throw browserError("wait for file preview", "the file preview did not appear within 30 s; nothing was sent");
  return preview;
}

// Enter sends, so line breaks are typed as Shift+Enter.
async function typeMultilineText(page, text) {
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex > 0) await page.keyboard.press("Shift+Enter");
    if (line) await page.keyboard.insertText(line);
  }
}

/**
 * Reads the conversation's message rows once they stop changing (two identical reads),
 * so bubbles that render late are not mistaken for new ones. An empty conversation is
 * only trusted after EMPTY_SETTLE_ATTEMPTS reads.
 *
 * @returns Raw message rows (Promise<Array<object>>)
 */
async function readSettledMessageRows(page) {
  let previousSignature = null;
  let readCount = 0;
  const isSettled = (rawRows) => {
    readCount += 1;
    const signature = rawRows.map((rawRow) => rawRow.dataId).join("|");
    const isStable = signature === previousSignature;
    previousSignature = signature;
    return isStable && (rawRows.length > 0 || readCount >= EMPTY_SETTLE_ATTEMPTS);
  };
  return runStep("read messages", () => pollProbe(page, probeMessageRows, SELECTORS.conversation, isSettled, SETTLE_ATTEMPTS));
}

async function readKnownMessageIds(page) {
  return new Set(parseMessageRows(await readSettledMessageRows(page), Infinity).map((message) => message.id));
}

async function confirmSent(page, { knownMessageIds, expectedContent, maxAttempts }) {
  const findSent = (rawRows) => findNewOutgoingMessage(rawRows, knownMessageIds, expectedContent);
  const rawRows = await runStep("confirm sent", () => pollProbe(page, probeMessageRows, SELECTORS.conversation, (rows) => Boolean(findSent(rows)), maxAttempts));
  const sentMessage = findSent(rawRows);
  if (!sentMessage) {
    throw browserError("confirm sent", "the sent message did not appear in the chat; check WhatsApp before sending again to avoid a duplicate");
  }
  const isDelivered = (rows) => findSent(rows)?.status !== "pending";
  const settledRows = await runStep("wait for delivery tick", () => pollProbe(page, probeMessageRows, SELECTORS.conversation, isDelivered, DELIVERY_ATTEMPTS));
  return findSent(settledRows) ?? sentMessage;
}
