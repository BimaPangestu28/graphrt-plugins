/**
 * High-level WhatsApp Web driver used by the operations. Each method is one
 * queued browser session task (see lib/browser-session.mjs) built from the
 * page actions in lib/whatsapp-page.mjs. Operations depend on this interface
 * only, so their tests inject a fake driver.
 */
import { listChats, openChat, readLoginStatus, readMessages, searchChats, sendFile, sendText, waitForLogin } from "./whatsapp-page.mjs";

/**
 * Creates the driver on top of a browser session.
 *
 * @param session - Browser session from createBrowserSession (object)
 * @returns Driver with getStatus, login, listChats, searchChats, readMessages, sendText, sendFile, close (object)
 */
export function createWhatsAppDriver(session) {
  return {
    getStatus: ({ signal }) => session.run((page) => readLoginStatus(page), { signal }),
    // Login is the only visible window; it is closed again afterwards so later runs are headless.
    login: ({ timeoutMs, signal }) => session.run((page) => waitForLogin(page, { timeoutMs }), { headed: true, closeAfter: true, signal }),
    listChats: ({ limit, unreadOnly, signal }) => session.run((page) => listChats(page, { limit, unreadOnly }), { signal }),
    searchChats: ({ query, limit, signal }) => session.run((page) => searchChats(page, { query, limit }), { signal }),
    readMessages: ({ target, limit, signal }) =>
      session.run(async (page) => {
        const chat = await openChat(page, target);
        return { chat, messages: await readMessages(page, { limit }) };
      }, { signal }),
    sendText: ({ target, text, beforeSend, signal }) =>
      session.run(async (page) => {
        const chat = await openChat(page, target);
        const usage = await beforeSend();
        return { chat, usage, message: await sendText(page, { text }) };
      }, { signal }),
    sendFile: ({ target, filePath, caption, asDocument, beforeSend, signal }) =>
      session.run(async (page) => {
        const chat = await openChat(page, target);
        const usage = await beforeSend();
        return { chat, usage, message: await sendFile(page, { filePath, caption, asDocument }) };
      }, { signal }),
    close: () => session.close(),
  };
}
