/**
 * Every WhatsApp Web URL and DOM selector the plugin depends on, in one place.
 *
 * WhatsApp Web changes its markup without notice and removed most `data-testid`
 * attributes in 2023, so these lean on ids, ARIA roles, `data-*` attributes that
 * carry message data, and `data-icon` names. Each entry lists fallbacks joined
 * with ", " (CSS "any of"). When the UI changes, this is the only file to update.
 *
 * Checked against the WhatsApp Web markup as of late 2026 (unverified against a
 * logged-in session by the builder: only the login screen was checked live).
 */

/** WhatsApp Web entry point. */
export const WHATSAPP_WEB_URL = "https://web.whatsapp.com/";

/**
 * Click-to-chat URL that opens a chat with any number, even one not in the chat list.
 *
 * @param phoneDigits - International number, digits only, e.g. "628123456789" (string)
 * @returns URL string (string)
 */
export function buildSendToPhoneUrl(phoneDigits) {
  return `https://web.whatsapp.com/send?phone=${encodeURIComponent(phoneDigits)}`;
}

export const SELECTORS = {
  login: {
    // The QR code is drawn on a canvas inside a container whose `data-ref` holds the QR payload.
    qrCode: 'div[data-ref] canvas, canvas[aria-label*="QR" i], canvas[aria-label*="scan" i]',
    // Left pane with the chat list; present only once logged in and synced.
    chatListPane: "#pane-side",
    // Splash / sync screen shown while the app loads (progress bar, "Loading your chats").
    loadingScreen: 'progress, div[data-testid="startup-progress"], #app div[role="progressbar"]',
  },
  chatList: {
    // Scrollable left pane (virtualised: only visible rows are in the DOM).
    pane: "#pane-side",
    // One chat row. Newer builds use role=listitem, older ones role=row inside a grid.
    row: '#pane-side div[role="listitem"], #pane-side div[role="row"]',
    // Chat name: the first `span[title]` in a row carries the full name in its title attribute.
    rowTitle: "span[title]",
    // Unread badge; its aria-label reads e.g. "3 unread messages".
    unreadBadge: 'span[aria-label*="unread" i]',
  },
  search: {
    // Search box above the chat list (a contenteditable textbox in current builds, an input in some).
    input: [
      '#side div[contenteditable="true"][role="textbox"]',
      '#side input[role="textbox"]',
      '#side input[type="text"]',
      '#side div[contenteditable="true"][data-tab="3"]',
    ].join(", "),
  },
  conversation: {
    // Right pane holding the open conversation.
    main: "#main",
    // Conversation header; its first `span[title]` / `span[dir="auto"]` is the chat name.
    headerTitle: '#main header span[title], #main header span[dir="auto"]',
    // Every message bubble container carries `data-id` = "<fromMe>_<chatJid>_<messageId>[_<participant>]".
    messageRow: "#main div[data-id]",
    // Text-bearing part of a bubble: `data-pre-plain-text` = "[10:42, 18/11/2026] Alice: ".
    prePlainText: "[data-pre-plain-text]",
    // Message body text.
    messageText: "span.selectable-text",
    // Delivery icons on outgoing messages (data-icon names: msg-time, msg-check, msg-dblcheck...).
    deliveryIcon: "span[data-icon^='msg-'], span[data-icon$='-check'], span[data-icon$='dblcheck']",
  },
  composer: {
    // Message box in the conversation footer.
    messageBox: [
      '#main footer div[contenteditable="true"][role="textbox"]',
      '#main footer div[contenteditable="true"][data-tab="10"]',
      '#main footer div[contenteditable="true"]',
    ].join(", "),
    // Attach ("+" / paperclip) button.
    attachButton: [
      '#main footer button[title="Attach"]',
      '#main footer div[role="button"][title="Attach"]',
      '#main footer span[data-icon="plus-rounded"]',
      '#main footer span[data-icon="plus"]',
      '#main footer span[data-icon="attach-menu-plus"]',
      '#main footer span[data-icon="clip"]',
    ].join(", "),
    // Hidden file inputs inside the attach menu: media (images/videos) and documents (any type).
    mediaFileInput: 'input[type="file"][accept*="image"]',
    documentFileInput: 'input[type="file"][accept="*"], input[type="file"]:not([accept*="image"])',
    // Caption box in the media / document preview.
    captionBox: [
      'div[contenteditable="true"][aria-label*="caption" i]',
      'div[aria-label*="caption" i] div[contenteditable="true"]',
      'div[contenteditable="true"][data-tab="undefined"]',
    ].join(", "),
    // Send button candidates; only the one inside the preview is used (see probeMarkFilePreview).
    previewSendButton: [
      'div[role="button"][aria-label="Send"]',
      'button[aria-label="Send"]',
      'span[data-icon="send"]',
      'span[data-icon="wds-ic-send-filled"]',
    ].join(", "),
    // Media / document preview overlay, used to find the preview when it has no caption box.
    previewContainer: 'div[data-animate-media-viewer], div[aria-label*="preview" i], div[data-testid*="media-editor"]',
    // The conversation's own composer: its send button must never be taken for the preview's.
    previewExcludedArea: "#main footer",
    // Elements marked by probeMarkFilePreview once the preview is showing.
    markedPreviewSendButton: '[data-graphrt-preview="send"]',
    markedPreviewCaption: '[data-graphrt-preview="caption"]',
  },
  dialogs: {
    // Modal shown when /send?phone= points at a number that is not on WhatsApp.
    popup: 'div[role="dialog"], div[data-animate-modal-popup="true"]',
  },
};

/** Text that, inside a popup, means the click-to-chat number is not on WhatsApp. */
export const INVALID_PHONE_POPUP_PATTERN = /invalid|not on whatsapp|tidak valid|tidak terdaftar/i;
