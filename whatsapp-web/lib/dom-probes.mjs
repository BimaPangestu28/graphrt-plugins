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
 * Counts the chat rows (or search results) whose title is exactly this name.
 *
 * @param lookup - `{rowSelector, titleSelector, name}` (object)
 * @returns Number of rows titled `name` (number)
 */
export function probeCountChatsNamed(lookup) {
  return [...document.querySelectorAll(lookup.rowSelector)].filter(
    (row) => row.querySelector(lookup.titleSelector)?.getAttribute("title") === lookup.name,
  ).length;
}

/**
 * Reads the text of a contenteditable editor (message or caption box). Emoji drawn as
 * `<img alt>` are read from their alt text and paragraphs / `<br>` become line breaks.
 *
 * @param editorSelector - CSS selector of the editor; the first match is read (string)
 * @returns The editor text, or null when no editor matches (string | null)
 */
export function probeEditableText(editorSelector) {
  const editor = document.querySelector(editorSelector);
  if (!editor) return null;
  const textParts = [];
  const readNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return void textParts.push(node.data);
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.tagName === "IMG") return void textParts.push(node.getAttribute("alt") ?? "");
    if (node.tagName === "BR") return void textParts.push("\n");
    if ((node.tagName === "P" || node.tagName === "DIV") && textParts.length) textParts.push("\n");
    node.childNodes.forEach(readNode);
  };
  editor.childNodes.forEach(readNode);
  return textParts.join("");
}

/**
 * Finds the file preview's send button and caption box and marks them with
 * `data-graphrt-preview="send" | "caption"`, so the page can click exactly those.
 * Starts from a caption box (or a preview container) outside `excludedArea` and walks
 * up to the nearest ancestor that also holds a send button outside `excludedArea`,
 * so the conversation's own send button is never chosen.
 *
 * @param previewRequest - `{captionBox, container, sendButton, excludedArea}` selectors (object)
 * @returns `{found, hasCaptionBox}` (object)
 */
export function probeMarkFilePreview(previewRequest) {
  document.querySelectorAll("[data-graphrt-preview]").forEach((element) => element.removeAttribute("data-graphrt-preview"));
  const isOutside = (element) => !element.closest(previewRequest.excludedArea);
  const sendButtons = [...document.querySelectorAll(previewRequest.sendButton)].filter(isOutside);
  const captionBoxes = [...document.querySelectorAll(previewRequest.captionBox)].filter(isOutside);
  const anchors = [...captionBoxes, ...[...document.querySelectorAll(previewRequest.container)].filter(isOutside)];
  for (const anchor of anchors) {
    for (let ancestor = anchor; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const sendButton = sendButtons.find((button) => ancestor.contains(button));
      if (!sendButton) continue;
      const captionBox = captionBoxes.find((box) => ancestor.contains(box)) ?? null;
      sendButton.setAttribute("data-graphrt-preview", "send");
      captionBox?.setAttribute("data-graphrt-preview", "caption");
      return { found: true, hasCaptionBox: Boolean(captionBox) };
    }
  }
  return { found: false, hasCaptionBox: false };
}
