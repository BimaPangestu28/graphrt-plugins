import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeChatRows,
  probeConversationState,
  probeHasChatNamed,
  probeLoginSignals,
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

function messageRow(dataId, text, iconNames = []) {
  return { dataId, prePlainText: `[10:00, 18/11/2026] Someone: `, text, iconNames, iconLabels: [] };
}

function pageWith(responses, url = WHATSAPP_WEB_URL) {
  return createFakePage({ url, probeResponses: new Map(responses) });
}

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

test("openChat by phone uses click-to-chat and returns the header name", async () => {
  const page = pageWith([[probeConversationState, () => ({ hasMessageBox: true, popupText: null, hasQrCode: false, headerTitle: "Budi" })]]);
  assert.deepEqual(await openChat(page, { phone: "628123456789" }), { chat_name: "Budi" });
  assert.deepEqual(page.actions[0], ["goto", "https://web.whatsapp.com/send?phone=628123456789"]);
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
    [probeHasChatNamed, () => false],
  ]);
  await assert.rejects(openChat(page, { name: "Nobody" }), { kind: "not_found" });
  assert.deepEqual(page.actions.filter(([action]) => action === "fill").map(([, , value]) => value), ["Nobody", ""]);
});

test("openChat by name refuses when the header shows another chat (never sends to the wrong chat)", async () => {
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeHasChatNamed, (lookup) => lookup.name === "Ibu"],
    [probeConversationState, () => ({ hasMessageBox: true, popupText: null, hasQrCode: false, headerTitle: "Someone else" })],
  ]);
  await assert.rejects(openChat(page, { name: "Ibu" }), (error) => error.kind === "browser_error" && /open chat/.test(error.message));
});

test("openChat by name clicks the exact title and waits for the matching header", async () => {
  const page = pageWith([
    [probeLoginSignals, () => LOGGED_IN],
    [probeHasChatNamed, () => true],
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

test("sendText types lines with Shift+Enter, presses Enter and waits for the tick", async () => {
  const before = [messageRow("true_1@c.us_OLD", "old", ["msg-dblcheck"])];
  const page = pageWith([
    [
      probeMessageRows,
      (argument, callIndex) => {
        if (callIndex === 0) return before;
        return [...before, messageRow("true_1@c.us_NEW", "a\nb", [callIndex < 3 ? "msg-time" : "msg-check"])];
      },
    ],
  ]);
  const sentMessage = await sendText(page, { text: "a\nb" });
  assert.equal(sentMessage.id, "NEW");
  assert.equal(sentMessage.status, "sent");
  const keyboardActions = page.actions.filter(([action]) => action === "insertText" || action === "press");
  assert.deepEqual(keyboardActions, [["insertText", "a"], ["press", "Shift+Enter"], ["insertText", "b"], ["press", "Enter"]]);
});

test("sendText reports browser_error (no retry) when the message never appears", async () => {
  const page = pageWith([[probeMessageRows, () => [messageRow("true_1@c.us_OLD", "old")]]]);
  await assert.rejects(sendText(page, { text: "hi" }), (error) => error.kind === "browser_error" && /duplicate/.test(error.message));
  assert.equal(page.actions.filter(([action, key]) => action === "press" && key === "Enter").length, 1);
});

test("sendFile uses the media input for photos and types the caption", async () => {
  const page = pageWith([[probeMessageRows, (argument, callIndex) => (callIndex === 0 ? [] : [messageRow("true_1@c.us_PIC", "", ["msg-check"])])]]);
  const sentMessage = await sendFile(page, { filePath: "/tmp/p.png", caption: "lihat", asDocument: false });
  assert.equal(sentMessage.id, "PIC");
  assert.ok(page.actions.some(([action, selector, filePath]) => action === "setInputFiles" && selector === SELECTORS.composer.mediaFileInput && filePath === "/tmp/p.png"));
  assert.ok(page.actions.some(([action, text]) => action === "insertText" && text === "lihat"));
  assert.ok(page.actions.some(([action, selector]) => action === "click" && selector === SELECTORS.composer.previewSendButton));
});

test("sendFile uses the document input for documents", async () => {
  const page = pageWith([[probeMessageRows, (argument, callIndex) => (callIndex === 0 ? [] : [messageRow("true_1@c.us_DOC", "", ["msg-check"])])]]);
  await sendFile(page, { filePath: "/tmp/a.pdf", asDocument: true });
  assert.ok(page.actions.some(([action, selector]) => action === "setInputFiles" && selector === SELECTORS.composer.documentFileInput));
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
