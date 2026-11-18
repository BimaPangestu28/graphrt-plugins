/**
 * WhatsApp Web page actions on a Playwright page: login detection, opening a
 * chat, reading the chat list and messages, sending text and files.
 *
 * DOM reads go through lib/dom-probes.mjs and are interpreted by lib/parse.mjs;
 * selectors live in lib/selectors.mjs. Waiting is done by polling probes
 * (`pollProbe`), so behaviour does not depend on a single selector appearing.
 * Every step is wrapped in `runStep` so failures name the step (`browser_error`).
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";
import { browserError, notFound, notLoggedIn, runStep } from "./errors.mjs";
import {
  probeChatRows,
  probeConversationState,
  probeHasChatNamed,
  probeLoginSignals,
  probeMessageRows,
  probeScrollChatList,
  probeScrollMessagesUp,
} from "./dom-probes.mjs";
import { determineLoginStatus, findNewOutgoingMessage, isUnsupportedBrowserPage, mergeChatRows, parseChatRows, parseMessageRows } from "./parse.mjs";
import { INVALID_PHONE_POPUP_PATTERN, SELECTORS, WHATSAPP_WEB_URL, buildSendToPhoneUrl } from "./selectors.mjs";

export const POLL_INTERVAL_MS = 500;
// Page loads wait for the HTML only (the app renders afterwards); slow links can still take tens of seconds.
const NAVIGATION_OPTIONS = { waitUntil: "domcontentloaded", timeout: 60000 };
const APP_LOAD_ATTEMPTS = 120; // 60 s: first load of a big account is slow
const CHAT_OPEN_ATTEMPTS = 60; // 30 s
const SEARCH_ATTEMPTS = 8; // 4 s for search results
const MESSAGE_WAIT_ATTEMPTS = 10; // 5 s; an empty chat has no bubbles at all
const SEND_CONFIRM_ATTEMPTS = 60; // 30 s for the bubble to appear
const UPLOAD_CONFIRM_ATTEMPTS = 240; // 120 s for a file upload
const DELIVERY_ATTEMPTS = 30; // 15 s for the clock icon to turn into a tick
const LOGIN_SETTLE_MS = 8000; // let the first sync write the session before the window closes
const SCROLL_SETTLE_MS = 600;
const MAX_CHAT_SCROLLS = 40;
const MAX_MESSAGE_SCROLLS = 10;
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
 * @param options.timeoutMs - How long to wait for the scan (number)
 * @returns `{status: "logged_in", already_logged_in}` (Promise<object>)
 * @throws PluginError kind `auth_error` - When the QR code was not scanned in time
 */
export async function waitForLogin(page, { timeoutMs }) {
  if ((await readLoginStatus(page)) === "logged_in") return { status: "logged_in", already_logged_in: true };
  console.error(`[whatsapp-web] waiting up to ${Math.round(timeoutMs / 1000)} s for the QR code to be scanned`);
  const maxAttempts = Math.ceil(timeoutMs / POLL_INTERVAL_MS);
  const signals = await runStep("wait for QR scan", () => pollProbe(page, probeLoginSignals, SELECTORS.login, (loginSignals) => loginSignals.hasChatList, maxAttempts));
  if (!signals?.hasChatList) {
    throw new PluginError(`The QR code was not scanned within ${Math.round(timeoutMs / 1000)} s; run the login node again`, { kind: "auth_error" });
  }
  await page.waitForTimeout(LOGIN_SETTLE_MS);
  return { status: "logged_in", already_logged_in: false };
}

/**
 * Opens a conversation by phone number or by exact chat name.
 *
 * @param target - `{phone}` (digits) or `{name}` (object)
 * @returns `{chat_name}` as shown in the conversation header (Promise<object>)
 * @throws PluginError kinds `auth_error`, `not_found`, `browser_error`
 */
export async function openChat(page, target) {
  return target.phone ? openChatByPhone(page, target.phone) : openChatByName(page, target.name);
}

async function openChatByPhone(page, phoneDigits) {
  await runStep("open chat by phone", () => page.goto(buildSendToPhoneUrl(phoneDigits), NAVIGATION_OPTIONS));
  const isSettled = (state) => state.hasMessageBox || state.hasQrCode || INVALID_PHONE_POPUP_PATTERN.test(state.popupText ?? "");
  const state = await runStep("wait for chat", () => pollProbe(page, probeConversationState, CONVERSATION_STATE_SELECTORS, isSettled, APP_LOAD_ATTEMPTS));
  if (state.hasMessageBox) return { chat_name: state.headerTitle };
  if (state.hasQrCode) throw notLoggedIn();
  if (INVALID_PHONE_POPUP_PATTERN.test(state.popupText ?? "")) throw notFound(`+${phoneDigits} is not on WhatsApp (${state.popupText.trim()})`);
  throw browserError("open chat by phone", "the conversation did not open within 60 s");
}

async function openChatByName(page, chatName) {
  await assertLoggedIn(page);
  await runStep("search chat", () => page.locator(SELECTORS.search.input).first().fill(chatName));
  const lookup = { rowSelector: SELECTORS.chatList.row, titleSelector: SELECTORS.chatList.rowTitle, name: chatName };
  const isFound = await runStep("find chat", () => pollProbe(page, probeHasChatNamed, lookup, Boolean, SEARCH_ATTEMPTS));
  if (!isFound) {
    await clearSearch(page);
    throw notFound(`No chat named ${JSON.stringify(chatName)} (the name must match exactly as shown in WhatsApp); use \`phone\` for numbers`);
  }
  await runStep("open chat", () => page.locator(SELECTORS.chatList.pane).getByTitle(chatName, { exact: true }).first().click());
  // The header must show this chat, so a previously open chat is never mistaken for it.
  const isOpen = (state) => state.hasMessageBox && state.headerTitle === chatName;
  const state = await runStep("wait for chat", () => pollProbe(page, probeConversationState, CONVERSATION_STATE_SELECTORS, isOpen, CHAT_OPEN_ATTEMPTS));
  if (!isOpen(state)) throw browserError("open chat", `the conversation header shows ${JSON.stringify(state.headerTitle)}, not ${JSON.stringify(chatName)}`);
  return { chat_name: chatName };
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
  let chats = [];
  for (let scrollCount = 0; scrollCount < MAX_CHAT_SCROLLS; scrollCount += 1) {
    chats = mergeChatRows(chats, parseChatRows(await runStep("read chat list", () => page.evaluate(probeChatRows, SELECTORS.chatList))));
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
 *
 * @returns The sent message `{id, from_me, time, text, status, ...}` (Promise<object>)
 * @throws PluginError kind `browser_error` - When a step fails or the message never appears
 */
export async function sendText(page, { text }) {
  const knownMessageIds = await readMessageIds(page);
  await runStep("focus message box", () => page.locator(SELECTORS.composer.messageBox).first().click());
  await runStep("type message", () => typeMultilineText(page, text));
  await runStep("press Enter", () => page.keyboard.press("Enter"));
  return confirmSent(page, knownMessageIds, SEND_CONFIRM_ATTEMPTS);
}

/**
 * Attaches a local file (as media or document) with an optional caption and sends it.
 *
 * @returns The sent message (Promise<object>)
 */
export async function sendFile(page, { filePath, caption, asDocument }) {
  const knownMessageIds = await readMessageIds(page);
  await runStep("open attach menu", () => page.locator(SELECTORS.composer.attachButton).first().click());
  const inputSelector = asDocument ? SELECTORS.composer.documentFileInput : SELECTORS.composer.mediaFileInput;
  await runStep("attach file", () => page.locator(inputSelector).first().setInputFiles(filePath));
  if (caption) {
    await runStep("focus caption box", () => page.locator(SELECTORS.composer.captionBox).first().click());
    await runStep("type caption", () => typeMultilineText(page, caption));
  }
  await runStep("send file", () => page.locator(SELECTORS.composer.previewSendButton).first().click());
  return confirmSent(page, knownMessageIds, UPLOAD_CONFIRM_ATTEMPTS);
}

// Enter sends, so line breaks are typed as Shift+Enter.
async function typeMultilineText(page, text) {
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex > 0) await page.keyboard.press("Shift+Enter");
    if (line) await page.keyboard.insertText(line);
  }
}

async function readMessageIds(page) {
  const rawRows = await runStep("read messages", () => page.evaluate(probeMessageRows, SELECTORS.conversation));
  return new Set(parseMessageRows(rawRows, Infinity).map((message) => message.id));
}

async function confirmSent(page, knownMessageIds, maxAttempts) {
  const findSent = (rawRows) => findNewOutgoingMessage(rawRows, knownMessageIds);
  const rawRows = await runStep("confirm sent", () => pollProbe(page, probeMessageRows, SELECTORS.conversation, (rows) => Boolean(findSent(rows)), maxAttempts));
  const sentMessage = findSent(rawRows);
  if (!sentMessage) {
    throw browserError("confirm sent", "the message did not appear in the chat; check WhatsApp before sending again to avoid a duplicate");
  }
  const isDelivered = (rows) => findNewOutgoingMessage(rows, knownMessageIds)?.status !== "pending";
  const settledRows = await runStep("wait for delivery tick", () => pollProbe(page, probeMessageRows, SELECTORS.conversation, isDelivered, DELIVERY_ATTEMPTS));
  return findSent(settledRows) ?? sentMessage;
}
