import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../lib/dom-probes.mjs";
import { SELECTORS, WHATSAPP_WEB_URL } from "../lib/selectors.mjs";
import { assertLoggedIn, listChats, openChat, readLoginStatus, readMessages, sendFile, sendText, waitForLogin } from "../lib/whatsapp-page.mjs";
import { createFakePage } from "./helpers.mjs";

const LOGGED_IN = { hasChatList: true, hasQrCode: false };
const QR_SHOWN = { hasChatList: false, hasQrCode: true };
const STILL_LOADING = { hasChatList: false, hasQrCode: false };
const CHAT_OPEN = { hasMessageBox: true, popupText: null, hasQrCode: false, headerTitle: "Budi" };
const PREVIEW_READY = { found: true, hasCaptionBox: true };

function messageRow(dataId, text, iconNames = []) {
  return { dataId, prePlainText: `[10:00, 18/11/2026] Someone: `, text, iconNames, iconLabels: [] };
}

function pageWith(responses, url = WHATSAPP_WEB_URL) {
  return createFakePage({ url, probeResponses: new Map(responses) });
}

const isSendAction = ([action, key]) =>
  (action === "press" && key === "Enter") || (action === "click" && key === SELECTORS.composer.markedPreviewSendButton);

/**
 * Replays the keyboard actions like a WhatsApp editor holding `draft`:
 * ControlOrMeta+A then Backspace clears it, insertText appends, Shift+Enter adds a line break.
 */
function readFakeEditorText(page, draft) {
  let editorText = draft;
  let isAllSelected = false;
  for (const [action, value] of page.actions) {
    if (isSendAction([action, value])) editorText = "";
    else if (action === "press" && value === "ControlOrMeta+A") isAllSelected = true;
    else if (action === "press" && value === "Backspace" && isAllSelected) [editorText, isAllSelected] = ["", false];
    else if (action === "press" && value === "Shift+Enter") editorText += "\n";
    else if (action === "insertText") editorText += value;
  }
  return editorText;
}

/**
 * A page with an open conversation. `before` rows show until something is sent, then `after(readIndex)`.
 * The editor starts with `draft`; `composerText` overrides what the editor probe reads.
 */
function conversationPage({ before = [], after = () => before, draft = "", composerText, extraResponses = [] }) {
  let readsAfterSend = 0;
  const page = pageWith([
    [probeMessageRows, (argument, callIndex) => (page.actions.some(isSendAction) ? after(readsAfterSend++) : typeof before === "function" ? before(callIndex) : before)],
    [probeEditableText, () => composerText ?? readFakeEditorText(page, draft)],
    [probeMarkFilePreview, () => PREVIEW_READY],
    ...extraResponses,
  ]);
  page.editorTextAtSend = null;
  const pressKey = page.keyboard.press;
  page.keyboard.press = async (key) => {
    if (key === "Enter") page.editorTextAtSend = readFakeEditorText(page, draft);
    return pressKey(key);
  };
  return page;
}

const sendCount = (page) => page.actions.filter(isSendAction).length;

test("readLoginStatus opens WhatsApp Web and reports needs_login when the QR code shows", async () => {
  const page = pageWith([[probeLoginSignals, (argument, callIndex) => (callIndex < 2 ? STILL_LOADING : QR_SHOWN)]], "about:blank");
  assert.equal(await readLoginStatus(page), "needs_login");
  assert.deepEqual(page.actions[0], ["goto", WHATSAPP_WEB_URL]);
  assert.equal(page.probeCalls.get(probeLoginSignals), 3);
});

test("readLoginStatus passes the login selectors from selectors.mjs to the probe", async () => {
  let receivedSelectors;
  const page = pageWith([[probeLoginSignals, (argument) => ((receivedSelectors = argument), LOGGED_IN)]]);
  assert.equal(await readLoginStatus(page), "logged_in");
  assert.equal(receivedSelectors, SELECTORS.login);
  assert.equal(page.actions.length, 0, "already on WhatsApp Web: no reload");
});

test("readLoginStatus reports loading when nothing appears in time", async () => {
  const page = pageWith([[probeLoginSignals, () => STILL_LOADING]]);
  assert.equal(await readLoginStatus(page), "loading");
});

test("the unsupported-browser page is a browser_error, not an endless loading state", async () => {
  const page = pageWith([[probeLoginSignals, () => ({ ...STILL_LOADING, pageTextStart: "WhatsApp works with Google Chrome 100+" })]]);
  await assert.rejects(readLoginStatus(page), (error) => error.kind === "browser_error" && /unsupported/.test(error.message));
  assert.equal(page.probeCalls.get(probeLoginSignals), 1);
});

test("assertLoggedIn fails fast with auth_error on the QR screen", async () => {
  const page = pageWith([[probeLoginSignals, () => QR_SHOWN]]);
  await assert.rejects(assertLoggedIn(page), (error) => error.kind === "auth_error" && /login/.test(error.message));
  assert.equal(page.probeCalls.get(probeLoginSignals), 1);
});

test("assertLoggedIn reports a page that never loads as browser_error", async () => {
  const page = pageWith([[probeLoginSignals, () => STILL_LOADING]]);
  await assert.rejects(assertLoggedIn(page), (error) => error.kind === "browser_error" && /load WhatsApp Web/.test(error.message));
});

test("listChats on the QR screen fails with auth_error without reading the list", async () => {
  const page = pageWith([[probeLoginSignals, () => QR_SHOWN]]);
  await assert.rejects(listChats(page, { limit: 5, unreadOnly: false }), { kind: "auth_error" });
  assert.equal(page.probeCalls.has(probeChatRows), false);
});

test("listChats scrolls until enough unread chats are found", async () => {
  const batches = [
    [{ top: 0, title: "A", text: "A\n10:00\nhi", unreadLabel: null }, { top: 72, title: "B", text: "B\n09:00\nyo\n2", unreadLabel: "2 unread messages" }],
    [{ top: 144, title: "C", text: "C\n08:00\nhey\n1", unreadLabel: "1 unread message" }],
  ];
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeChatRows, (argument, callIndex) => batches[Math.min(callIndex, 1)]],
    [probeScrollChatList, () => ({ moved: true })],
  ]);
  const chats = await listChats(page, { limit: 2, unreadOnly: true });
  assert.deepEqual(chats.map((chat) => [chat.name, chat.unread_count]), [["B", 2], ["C", 1]]);
  assert.ok(page.actions.some(([action, selector, value]) => action === "fill" && selector === SELECTORS.search.input && value === ""), "search cleared first");
});

test("listChats keeps two different chats that share a name, and does not repeat rows seen again after scrolling", async () => {
  const batches = [
    [{ top: 0, title: "Budi", text: "Budi\n10:00\nhi", unreadLabel: null }, { top: 72, title: "Budi", text: "Budi\n09:00\nyo", unreadLabel: null }],
    [{ top: 72, title: "Budi", text: "Budi\n09:00\nyo", unreadLabel: null }, { top: 144, title: "C", text: "C\n08:00\nhey", unreadLabel: null }],
  ];
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeChatRows, (argument, callIndex) => batches[Math.min(callIndex, 1)]],
    [probeScrollChatList, (argument, callIndex) => ({ moved: callIndex < 2 })],
  ]);
  const chats = await listChats(page, { limit: 10, unreadOnly: false });
  assert.deepEqual(chats.map((chat) => [chat.name, chat.last_message]), [["Budi", "hi"], ["Budi", "yo"], ["C", "hey"]]);
});

test("openChat by phone uses click-to-chat and returns the header name", async () => {
  const page = pageWith([
    [probeConversationState, () => CHAT_OPEN],
    [probeMessageRows, () => [messageRow("false_628123456789@c.us_A", "halo")]],
  ]);
  assert.deepEqual(await openChat(page, { phone: "628123456789" }), { chat_name: "Budi" });
  assert.deepEqual(page.actions[0], ["goto", "https://web.whatsapp.com/send?phone=628123456789"]);
});

test("openChat by phone accepts a new chat without messages", async () => {
  const page = pageWith([
    [probeConversationState, () => CHAT_OPEN],
    [probeMessageRows, () => []],
  ]);
  assert.deepEqual(await openChat(page, { phone: "628123456789" }), { chat_name: "Budi" });
});

test("openChat by phone refuses when the open conversation's messages belong to another number", async () => {
  const page = pageWith([
    [probeConversationState, () => CHAT_OPEN],
    [probeMessageRows, () => [messageRow("false_6281999999999@c.us_A", "from someone else")]],
  ]);
  await assert.rejects(
    openChat(page, { phone: "628123456789" }),
    (error) => error.kind === "browser_error" && error.retryable === false && /6281999999999@c\.us/.test(error.message) && /\+628123456789/.test(error.message),
  );
});

test("openChat by phone checks the messages only after they stopped changing", async () => {
  const page = pageWith([
    [probeConversationState, () => CHAT_OPEN],
    // The previous chat's bubbles are still on screen for one read, then the new chat renders.
    [probeMessageRows, (argument, callIndex) => (callIndex === 0 ? [] : [messageRow("false_6281999999999@c.us_A", "other chat")])],
  ]);
  await assert.rejects(openChat(page, { phone: "628123456789" }), { kind: "browser_error" });
});

test("openChat by phone maps the invalid-number popup to not_found", async () => {
  const page = pageWith([[probeConversationState, () => ({ hasMessageBox: false, popupText: "Phone number shared via url is invalid.", hasQrCode: false })]]);
  await assert.rejects(openChat(page, { phone: "15550000000" }), { kind: "not_found" });
});

test("openChat by phone on the QR screen is auth_error", async () => {
  const page = pageWith([[probeConversationState, () => ({ hasMessageBox: false, popupText: null, hasQrCode: true })]]);
  await assert.rejects(openChat(page, { phone: "628123456789" }), { kind: "auth_error" });
});

test("openChat by name: unknown chat is not_found and the search is cleared", async () => {
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeCountChatsNamed, () => 0],
  ]);
  await assert.rejects(openChat(page, { name: "Nobody" }), { kind: "not_found" });
  assert.deepEqual(page.actions.filter(([action]) => action === "fill").map(([, , value]) => value), ["Nobody", ""]);
});

test("openChat by name refuses a name shared by two chats and suggests phone", async () => {
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeCountChatsNamed, () => 2],
  ]);
  await assert.rejects(openChat(page, { name: "Budi" }), (error) => error.kind === "invalid_input" && /2 chats/.test(error.message) && /`phone`/.test(error.message));
  assert.equal(page.actions.some(([action]) => action === "click"), false, "no chat is opened");
  assert.deepEqual(page.actions.filter(([action]) => action === "fill").map(([, , value]) => value), ["Budi", ""]);
});

test("openChat by name refuses when the header shows another chat (never sends to the wrong chat)", async () => {
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeCountChatsNamed, (lookup) => (lookup.name === "Ibu" ? 1 : 0)],
    [probeConversationState, () => ({ hasMessageBox: true, popupText: null, hasQrCode: false, headerTitle: "Someone else" })],
  ]);
  await assert.rejects(openChat(page, { name: "Ibu" }), (error) => error.kind === "browser_error" && /open chat/.test(error.message));
});

test("openChat by name clicks the exact title and waits for the matching header", async () => {
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeCountChatsNamed, () => 1],
    [probeConversationState, (argument, callIndex) => ({ hasMessageBox: true, popupText: null, hasQrCode: false, headerTitle: callIndex === 0 ? "Old chat" : "Ibu" })],
  ]);
  assert.deepEqual(await openChat(page, { name: "Ibu" }), { chat_name: "Ibu" });
  assert.ok(page.actions.some(([action, selector]) => action === "click" && selector.endsWith("title=Ibu")));
});

test("readMessages scrolls up for older messages until the limit is met", async () => {
  const page = pageWith([
    [probeMessageRows, (argument, callIndex) => (callIndex === 0 ? [messageRow("false_1@c.us_B", "two")] : [messageRow("false_1@c.us_A", "one"), messageRow("false_1@c.us_B", "two")])],
    [probeScrollMessagesUp, () => ({ moved: true })],
  ]);
  const messages = await readMessages(page, { limit: 2 });
  assert.deepEqual(messages.map((message) => message.text), ["one", "two"]);
});

test("readMessages of an empty chat returns no messages", async () => {
  const page = pageWith([
    [probeMessageRows, () => []],
    [probeScrollMessagesUp, () => ({ moved: false })],
  ]);
  assert.deepEqual(await readMessages(page, { limit: 5 }), []);
});

const OLD_ROW = messageRow("true_1@c.us_OLD", "old", ["msg-dblcheck"]);

test("sendText clears the box, types lines with Shift+Enter, presses Enter and waits for the tick", async () => {
  const page = conversationPage({
    before: [OLD_ROW],
    after: (readIndex) => [OLD_ROW, messageRow("true_1@c.us_NEW", "a\nb", [readIndex < 2 ? "msg-time" : "msg-check"])],
  });
  const sentMessage = await sendText(page, { text: "a\nb" });
  assert.equal(sentMessage.id, "NEW");
  assert.equal(sentMessage.status, "sent");
  const keyboardActions = page.actions.filter(([action]) => action === "insertText" || action === "press");
  assert.deepEqual(keyboardActions, [
    ["press", "ControlOrMeta+A"],
    ["press", "Backspace"],
    ["insertText", "a"],
    ["press", "Shift+Enter"],
    ["insertText", "b"],
    ["press", "Enter"],
  ]);
});

test("sendText clears a leftover draft so only the intended text is sent", async () => {
  const page = conversationPage({ draft: "draft from yesterday ", after: () => [messageRow("true_1@c.us_NEW", "halo", ["msg-check"])] });
  await sendText(page, { text: "halo" });
  assert.equal(page.editorTextAtSend, "halo");
});

test("sendText refuses to press Enter when the box does not hold exactly the intended text", async () => {
  const page = conversationPage({ composerText: "draft from yesterday halo" });
  await assert.rejects(
    sendText(page, { text: "halo" }),
    (error) => error.kind === "browser_error" && error.retryable === false && /nothing was sent/.test(error.message),
  );
  assert.equal(sendCount(page), 0);
});

test("sendText cancelled while typing never presses Enter", async () => {
  const controller = new AbortController();
  const page = conversationPage({});
  const insertText = page.keyboard.insertText;
  page.keyboard.insertText = async (text) => {
    await insertText(text);
    controller.abort();
  };
  await assert.rejects(sendText(page, { text: "halo", signal: controller.signal }), { kind: "cancelled" });
  assert.equal(sendCount(page), 0);
});

test("sendText reports browser_error (no retry) when the message never appears", async () => {
  const page = conversationPage({ before: [OLD_ROW] });
  await assert.rejects(sendText(page, { text: "hi" }), (error) => error.kind === "browser_error" && /duplicate/.test(error.message));
  assert.equal(sendCount(page), 1);
});

test("sendText does not take an older bubble that renders late for the new message", async () => {
  const lateOldRow = messageRow("true_1@c.us_OLD", "hi", ["msg-dblcheck"]);
  // The first read happens before the conversation has rendered its bubbles.
  const page = conversationPage({ before: (readIndex) => (readIndex === 0 ? [] : [lateOldRow]), after: () => [lateOldRow] });
  await assert.rejects(sendText(page, { text: "hi" }), (error) => error.kind === "browser_error" && /confirm sent/.test(error.message));
});

test("sendText does not take another new outgoing message (e.g. typed on the phone) as confirmation", async () => {
  const page = conversationPage({ before: [OLD_ROW], after: () => [OLD_ROW, messageRow("true_1@c.us_PHONE", "sent from my phone", ["msg-check"])] });
  await assert.rejects(sendText(page, { text: "halo" }), (error) => error.kind === "browser_error" && /confirm sent/.test(error.message));
});

test("sendFile waits for the preview, types the caption in the preview and clicks the preview's own send button", async () => {
  const page = conversationPage({
    after: () => [messageRow("true_1@c.us_PIC", "lihat", ["msg-check"])],
    extraResponses: [[probeMarkFilePreview, (argument, callIndex) => (callIndex < 3 ? { found: false } : PREVIEW_READY)]],
  });
  const sentMessage = await sendFile(page, { filePath: "/tmp/p.png", caption: "lihat", asDocument: false });
  assert.equal(sentMessage.id, "PIC");
  assert.equal(page.probeCalls.get(probeMarkFilePreview), 4);
  assert.ok(page.actions.some(([action, selector, filePath]) => action === "setInputFiles" && selector === SELECTORS.composer.mediaFileInput && filePath === "/tmp/p.png"));
  assert.ok(page.actions.some(([action, selector]) => action === "click" && selector === SELECTORS.composer.markedPreviewCaption));
  assert.ok(page.actions.some(([action, text]) => action === "insertText" && text === "lihat"));
  assert.ok(page.actions.some(([action, selector]) => action === "click" && selector === SELECTORS.composer.markedPreviewSendButton));
  assert.equal(page.actions.some(([action, selector]) => action === "click" && selector === SELECTORS.composer.previewSendButton), false);
});

test("the preview probe is told to ignore the conversation's own send button", async () => {
  let previewRequest;
  const page = conversationPage({
    after: () => [messageRow("true_1@c.us_DOC", "", ["msg-check"])],
    extraResponses: [[probeMarkFilePreview, (argument) => ((previewRequest = argument), PREVIEW_READY)]],
  });
  await sendFile(page, { filePath: "/tmp/a.pdf", asDocument: true });
  assert.equal(previewRequest.excludedArea, "#main footer");
  assert.equal(previewRequest.sendButton, SELECTORS.composer.previewSendButton);
});

test("sendFile without a preview never clicks send", async () => {
  const page = conversationPage({ extraResponses: [[probeMarkFilePreview, () => ({ found: false })]] });
  await assert.rejects(sendFile(page, { filePath: "/tmp/p.png", asDocument: false }), (error) => error.kind === "browser_error" && /preview/.test(error.message));
  assert.equal(sendCount(page), 0);
});

test("sendFile clears a draft carried into the caption box when no caption is given", async () => {
  const page = conversationPage({ draft: "half-typed note", after: () => [messageRow("true_1@c.us_DOC", "", ["msg-check"])] });
  await sendFile(page, { filePath: "/tmp/a.pdf", asDocument: true });
  assert.ok(page.actions.some(([action, selector]) => action === "setInputFiles" && selector === SELECTORS.composer.documentFileInput));
  assert.ok(page.actions.some(([action, key]) => action === "press" && key === "Backspace"));
  assert.equal(sendCount(page), 1);
});

test("sendFile refuses to send when the caption box does not hold exactly the caption", async () => {
  const page = conversationPage({ composerText: "half-typed note lihat" });
  await assert.rejects(sendFile(page, { filePath: "/tmp/p.png", caption: "lihat", asDocument: false }), (error) => error.kind === "browser_error" && /nothing was sent/.test(error.message));
  assert.equal(sendCount(page), 0);
});

test("sendFile cancelled before the click never sends", async () => {
  const controller = new AbortController();
  const page = conversationPage({ extraResponses: [[probeMarkFilePreview, () => (controller.abort(), PREVIEW_READY)]] });
  await assert.rejects(sendFile(page, { filePath: "/tmp/p.png", asDocument: false, signal: controller.signal }), { kind: "cancelled" });
  assert.equal(sendCount(page), 0);
});

test("sendFile does not confirm with an unrelated new outgoing message", async () => {
  const page = conversationPage({ after: () => [messageRow("true_1@c.us_TXT", "unrelated text", ["msg-check"])] });
  await assert.rejects(sendFile(page, { filePath: "/tmp/p.png", caption: "lihat", asDocument: false }), (error) => /confirm sent/.test(error.message));
});

test("waitForLogin returns at once when already logged in", async () => {
  const page = pageWith([[probeLoginSignals, () => LOGGED_IN]]);
  assert.deepEqual(await waitForLogin(page, { timeoutMs: 1000 }), { status: "logged_in", already_logged_in: true });
});

test("waitForLogin waits for the scan, and times out with auth_error", async () => {
  const scannedPage = pageWith([[probeLoginSignals, (argument, callIndex) => (callIndex < 3 ? QR_SHOWN : LOGGED_IN)]]);
  assert.deepEqual(await waitForLogin(scannedPage, { timeoutMs: 5000 }), { status: "logged_in", already_logged_in: false });
  const ignoredPage = pageWith([[probeLoginSignals, () => QR_SHOWN]]);
  await assert.rejects(waitForLogin(ignoredPage, { timeoutMs: 1000 }), { kind: "auth_error" });
});

test("waitForLogin counts the page load against timeout_seconds", async () => {
  const startMs = 1_000_000;
  let nowCalls = 0;
  // The page load took 50 s of the 60 s budget: only 10 s (20 polls) are left for the scan.
  const now = () => (nowCalls++ === 0 ? startMs : startMs + 50000);
  const page = pageWith([[probeLoginSignals, () => QR_SHOWN]]);
  await assert.rejects(waitForLogin(page, { timeoutMs: 60000, now }), { kind: "auth_error" });
  assert.equal(page.probeCalls.get(probeLoginSignals), 1 + 20);
});
