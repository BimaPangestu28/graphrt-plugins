/**
 * Functions that run INSIDE the WhatsApp Web page through `page.evaluate(probe, selectors)`.
 *
 * Rules for this file: every function is self-contained (Playwright serialises
 * the function source, so it cannot use imports or module variables), receives
 * its selectors from lib/selectors.mjs as the argument, only reads raw values
 * (or scrolls), and leaves all interpretation to the pure functions in
 * lib/parse.mjs.
 */

/**
 * Reports which login-related elements are on screen.
 *
 * @param loginSelectors - SELECTORS.login (object)
 * @returns `{hasChatList, hasQrCode, hasLoadingScreen, pageTextStart}` (object)
 */
export function probeLoginSignals(loginSelectors) {
  return {
    hasChatList: Boolean(document.querySelector(loginSelectors.chatListPane)),
    hasQrCode: Boolean(document.querySelector(loginSelectors.qrCode)),
    hasLoadingScreen: Boolean(document.querySelector(loginSelectors.loadingScreen)),
    pageTextStart: (document.body?.innerText ?? "").slice(0, 200),
  };
}

/**
 * Reads the chat rows currently rendered in the (virtualised) chat list.
 *
 * @param chatListSelectors - SELECTORS.chatList (object)
 * @returns Rows `{top, title, text, unreadLabel}`; `top` is the row's offset in the list (Array<object>)
 */
export function probeChatRows(chatListSelectors) {
  const pane = document.querySelector(chatListSelectors.pane);
  const paneTop = pane ? pane.getBoundingClientRect().top - pane.scrollTop : 0;
  return [...document.querySelectorAll(chatListSelectors.row)].map((row) => ({
    top: Math.round(row.getBoundingClientRect().top - paneTop),
    title: row.querySelector(chatListSelectors.rowTitle)?.getAttribute("title") ?? "",
    text: row.innerText ?? "",
    unreadLabel: row.querySelector(chatListSelectors.unreadBadge)?.getAttribute("aria-label") ?? null,
  }));
}

/**
 * Scrolls the chat list: to the top, or down by one screen.
 *
 * @param scrollRequest - `{paneSelector, toTop}` (object)
 * @returns `{moved}`: false when the list could not scroll further (object)
 */
export function probeScrollChatList(scrollRequest) {
  const pane = document.querySelector(scrollRequest.paneSelector);
  if (!pane) return { moved: false };
  const previousScrollTop = pane.scrollTop;
  pane.scrollTop = scrollRequest.toTop ? 0 : previousScrollTop + pane.clientHeight * 0.8;
  return { moved: pane.scrollTop !== previousScrollTop };
}

/**
 * Reads the message bubbles rendered in the open conversation.
 *
 * @param conversationSelectors - SELECTORS.conversation (object)
 * @returns Rows `{dataId, prePlainText, text, iconNames, iconLabels}` in page order (Array<object>)
 */
export function probeMessageRows(conversationSelectors) {
  return [...document.querySelectorAll(conversationSelectors.messageRow)].map((row) => {
    const copyable = row.querySelector(conversationSelectors.prePlainText);
    const textElement = (copyable ?? row).querySelector(conversationSelectors.messageText);
    const icons = [...row.querySelectorAll("span[data-icon]")];
    return {
      dataId: row.getAttribute("data-id"),
      prePlainText: copyable?.getAttribute("data-pre-plain-text") ?? null,
      text: textElement?.innerText ?? "",
      iconNames: icons.map((icon) => icon.getAttribute("data-icon")),
      iconLabels: icons.map((icon) => icon.getAttribute("aria-label") ?? ""),
    };
  });
}

/**
 * Scrolls the open conversation to its top so older messages load.
 *
 * @param conversationSelectors - SELECTORS.conversation (object)
 * @returns `{moved}` (object)
 */
export function probeScrollMessagesUp(conversationSelectors) {
  let scroller = document.querySelector(conversationSelectors.messageRow)?.parentElement ?? null;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
  if (!scroller || scroller.scrollTop === 0) return { moved: false };
  scroller.scrollTop = 0;
  return { moved: true };
}

/**
 * Reports what the conversation area shows after opening a chat.
 *
 * @param stateSelectors - `{messageBox, popup, qrCode, headerTitle}` (object)
 * @returns `{hasMessageBox, popupText, hasQrCode, headerTitle}` (object)
 */
export function probeConversationState(stateSelectors) {
  const headerTitleElement = document.querySelector(stateSelectors.headerTitle);
  return {
    hasMessageBox: Boolean(document.querySelector(stateSelectors.messageBox)),
    popupText: document.querySelector(stateSelectors.popup)?.innerText ?? null,
    hasQrCode: Boolean(document.querySelector(stateSelectors.qrCode)),
    headerTitle: headerTitleElement?.getAttribute("title") || headerTitleElement?.innerText || null,
  };
}

/**
 * Checks whether the chat list (or search results) holds a chat with exactly this name.
 *
 * @param lookup - `{rowSelector, titleSelector, name}` (object)
 * @returns true when a row's title equals `name` (boolean)
 */
export function probeHasChatNamed(lookup) {
  return [...document.querySelectorAll(lookup.rowSelector)].some(
    (row) => row.querySelector(lookup.titleSelector)?.getAttribute("title") === lookup.name,
  );
}
