import { test } from "node:test";
import assert from "node:assert/strict";
import { probeConversationState, probeEditableText, probeMarkFilePreview, probeMessageRows } from "../lib/dom-probes.mjs";
import { WHATSAPP_WEB_URL } from "../lib/selectors.mjs";
import { createWhatsAppDriver } from "../lib/whatsapp-driver.mjs";
import { createFakePage } from "./helpers.mjs";

const CHAT_OPEN = { hasMessageBox: true, popupText: null, hasQrCode: false, headerTitle: "Budi" };

/** A session that runs each task on one fake page with an open, empty conversation. */
function createFakeSession(editorText) {
  const page = createFakePage({
    url: WHATSAPP_WEB_URL,
    probeResponses: new Map([
      [probeConversationState, () => CHAT_OPEN],
      [probeMessageRows, () => []],
      [probeEditableText, () => editorText],
      [probeMarkFilePreview, () => ({ found: true, hasCaptionBox: true })],
    ]),
  });
  return { page, run: (task) => task(page), close: async () => {} };
}

const isSendAction = ([action, value]) => (action === "press" && value === "Enter") || (action === "click" && /graphrt-preview="send"/.test(value));

test("a send cancelled during the send-interval wait never presses Enter", async () => {
  const session = createFakeSession("halo");
  const driver = createWhatsAppDriver(session);
  const controller = new AbortController();
  const beforeSend = async () => {
    controller.abort(); // the user cancels while the guard waits out the interval
    return { sends_today: 1, daily_limit: 50 };
  };
  await assert.rejects(driver.sendText({ target: { phone: "628123456789" }, text: "halo", beforeSend, signal: controller.signal }), { kind: "cancelled" });
  assert.equal(session.page.actions.some(isSendAction), false);
});

test("a file send cancelled during the send-interval wait never clicks send", async () => {
  const session = createFakeSession("");
  const driver = createWhatsAppDriver(session);
  const controller = new AbortController();
  const beforeSend = async () => {
    controller.abort();
    return { sends_today: 1, daily_limit: 50 };
  };
  const sendRequest = { target: { phone: "628123456789" }, filePath: "/tmp/a.pdf", asDocument: true, beforeSend, signal: controller.signal };
  await assert.rejects(driver.sendFile(sendRequest), { kind: "cancelled" });
  assert.equal(session.page.actions.some(isSendAction), false);
});
