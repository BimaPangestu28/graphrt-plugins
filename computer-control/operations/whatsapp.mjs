/**
 * `whatsapp_desktop_send`: a recipe over the primitives for WhatsApp for Mac.
 * It is a workflow node only (nodeOnly): a tool call cannot be cancelled, and a
 * timed-out tool call that still pressed Return would send twice. Agents should
 * send through the whatsapp-web or whatsapp-api plugins instead.
 *
 * Every step is checked before anything is typed or sent:
 *  1. Cmd+F, then the focused element must be a search field; only then is it
 *     cleared (Cmd+A Delete) and the chat name inserted, both gated on that field
 *     still having focus.
 *  2. Matches count only inside the chat list: a list/table/outline under the
 *     search field. Message bubbles, sender labels and the header never count.
 *     More than one distinct row (two chats with that name) fails `invalid_input`.
 *  3. After the click, the conversation header (right of the chat list, at the
 *     top of the window) must read the chat name.
 *  4. The message box (lowest text area right of the chat list) must exist, take
 *     focus and be empty; the message is inserted through Accessibility (never
 *     the clipboard) and read back.
 *  5. Right before Return the header is checked again, and press_keys checks
 *     WhatsApp is frontmost and the message box still has focus.
 *
 * UNVERIFIED: WhatsApp publishes no Accessibility reference for its Mac app. The
 * layout assumptions (Cmd+F search, chat list roles, header position, composer
 * being an AXTextArea, AXSelectedText insertion) are untested against a live
 * window; each one fails closed (an error, nothing sent) when it does not hold.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { normalizeAppKey } from "../lib/allowlist.mjs";
import { parseKeySequence } from "../lib/key-combos.mjs";
import { stripRefFingerprint } from "../lib/ui-tree.mjs";
import { MAX_VISITED_ELEMENTS, normalizeLineEndings, requireTextWithinLimit, TREE_SCRIPT_TIMEOUT_MS } from "./common.mjs";

export const WHATSAPP_APP_NAME = "WhatsApp";
export const WHATSAPP_BUNDLE_ID = "net.whatsapp.WhatsApp";
const SEARCH_RESULTS_WAIT_MS = 1500;
const CHAT_OPEN_WAIT_MS = 1000;
const TEXT_INPUT_ROLES = new Set(["AXTextField", "AXSearchField", "AXTextArea", "AXComboBox"]);
const SEARCH_FIELD_ROLES = new Set(["AXTextField", "AXSearchField"]);
const CHAT_LIST_ROLES = ["AXTable", "AXOutline", "AXList"];
const COMPOSER_ROLES = ["AXTextArea"];
/** The conversation header sits in this band at the top of the window (title bar + header row). */
const HEADER_ZONE_HEIGHT = 110;
const FRAME_TOLERANCE = 2;
const MAX_CHAT_NAME_LENGTH = 200;

// ---------- small helpers ----------

function runScript(context, scriptName, input, options = {}) {
  return context.client.runJxa(scriptName, { app: context.appName, ...input }, { signal: context.signal, ...options });
}

function pressKeys(context, keys, requireFocus = null) {
  return runScript(context, "press_keys", { steps: parseKeySequence(keys), ...(requireFocus ? { require_focus: requireFocus } : {}) });
}

function insertText(context, text, requireFocus) {
  return runScript(context, "type_text", { text, method: "insert", require_focus: requireFocus });
}

function findInWindow(context, query) {
  const input = { window: 1, root_ref: null, roles: null, text: null, exact: false, max_depth: 30, max_results: 20, max_visited: MAX_VISITED_ELEMENTS, ...query };
  return runScript(context, "find_elements", input, { timeoutMs: TREE_SCRIPT_TIMEOUT_MS });
}

function hasFrame(element) {
  return Array.isArray(element?.position) && Array.isArray(element?.size);
}

function frameOf(element) {
  const [left, top] = element.position;
  const [width, height] = element.size;
  return { left, top, right: left + width, bottom: top + height, centreX: left + width / 2 };
}

/** What press_keys / type_text compare against the focused element: role, left edge, bottom edge. */
function focusIdentityOf(element) {
  const { left, bottom } = frameOf(element);
  return { role: element.role, left, bottom };
}

function matchesFocusIdentity(element, identity) {
  if (!hasFrame(element) || element.role !== identity.role) return false;
  const { left, bottom } = frameOf(element);
  return Math.abs(left - identity.left) <= FRAME_TOLERANCE && Math.abs(bottom - identity.bottom) <= FRAME_TOLERANCE;
}

function hasExactText(element, wantedText) {
  const wantedLower = wantedText.toLowerCase();
  return [element.title, element.value, element.description].some((text) => typeof text === "string" && text.trim().toLowerCase() === wantedLower);
}

function isWithinRef(element, container) {
  const containerPath = stripRefFingerprint(container.ref);
  const elementPath = stripRefFingerprint(element.ref);
  return elementPath === containerPath || elementPath.startsWith(`${containerPath}/`);
}

function describeElement(element) {
  const label = element?.title ?? element?.description ?? element?.placeholder;
  return `${String(element?.role ?? "nothing").replace(/^AX/, "")}${label ? ` "${label}"` : ""}`;
}

async function failAfterEscape(context, error) {
  await pressKeys(context, "escape");
  throw error;
}

// ---------- steps ----------

async function focusSearchField(context) {
  await pressKeys(context, "cmd+f");
  const focused = await runScript(context, "read_focused_element", {});
  const isSearchField = hasFrame(focused) && (SEARCH_FIELD_ROLES.has(focused.role) || focused.subrole === "AXSearchField");
  if (!isSearchField) {
    throw new PluginError(`Cmd+F did not focus WhatsApp's chat search field (focus is on ${describeElement(focused)}); nothing was typed`, { kind: "not_found" });
  }
  return focused;
}

async function searchForChat(context, chatName) {
  const searchField = await focusSearchField(context);
  const searchFocus = focusIdentityOf(searchField);
  await pressKeys(context, "cmd+a delete", searchFocus);
  await insertText(context, chatName, searchFocus);
  await context.client.sleep(SEARCH_RESULTS_WAIT_MS, context.signal);
  return searchField;
}

function isListUnderSearchField(list, searchField) {
  if (!hasFrame(list)) return false;
  const listFrame = frameOf(list);
  const searchFrame = frameOf(searchField);
  return listFrame.left <= searchFrame.centreX && searchFrame.centreX <= listFrame.right && listFrame.top >= searchFrame.top;
}

async function readLayout(context, searchField) {
  const { windows } = await runScript(context, "list_windows", {});
  const mainWindow = windows?.[0];
  if (!hasFrame(mainWindow)) throw new PluginError("WhatsApp has no window with a frame", { kind: "not_found" });
  const { elements } = await findInWindow(context, { roles: CHAT_LIST_ROLES, max_results: 50 });
  const chatLists = elements.filter((list) => isListUnderSearchField(list, searchField));
  if (chatLists.length === 0) {
    await failAfterEscape(context, new PluginError("Could not find WhatsApp's chat list under the search field; nothing was typed", { kind: "not_found" }));
  }
  return { windowTop: frameOf(mainWindow).top, chatLists, sidebarRight: Math.max(...chatLists.map((list) => frameOf(list).right)) };
}

// Lists nested in another qualifying list are searched instead of their parent, so rows are the right grain.
function innermostLists(chatLists) {
  return chatLists.filter((list) => !chatLists.some((other) => other !== list && isWithinRef(other, list)));
}

// The row is the list's direct child on the element's path: a cell and its label count as one match.
function rowKeyOf(list, element) {
  const listPath = stripRefFingerprint(list.ref);
  const [rowIndex] = stripRefFingerprint(element.ref).slice(listPath.length + 1).split("/");
  return rowIndex ? `${listPath}/${rowIndex}` : listPath;
}

async function collectChatRows(context, layout, chatName) {
  const rows = new Map();
  for (const list of innermostLists(layout.chatLists)) {
    const { elements } = await findInWindow(context, { root_ref: list.ref, text: chatName, exact: true });
    for (const element of elements) {
      if (TEXT_INPUT_ROLES.has(element.role) || !hasExactText(element, chatName) || !isWithinRef(element, list)) continue;
      const rowKey = rowKeyOf(list, element);
      rows.set(rowKey, [...(rows.get(rowKey) ?? []), element]);
    }
  }
  return rows;
}

async function findChatRow(context, layout, chatName) {
  const rows = await collectChatRows(context, layout, chatName);
  if (rows.size === 0) {
    await failAfterEscape(context, new PluginError(`No WhatsApp chat named "${chatName}" in the chat list; check the exact chat name`, { kind: "not_found" }));
  }
  if (rows.size > 1) {
    const message = `${rows.size} chats in WhatsApp's chat list are named "${chatName}"; rename one or send another way (nothing was sent)`;
    await failAfterEscape(context, new PluginError(message, { kind: "invalid_input" }));
  }
  const [rowElements] = rows.values();
  // The shallowest element is the row (or cell) itself, the likeliest to support AXPress.
  return rowElements.sort((first, second) => first.ref.split("/").length - second.ref.split("/").length)[0];
}

function isConversationHeader(element, layout, chatName) {
  if (!hasFrame(element) || TEXT_INPUT_ROLES.has(element.role) || !hasExactText(element, chatName)) return false;
  const frame = frameOf(element);
  const isInHeaderZone = frame.left >= layout.sidebarRight && frame.top < layout.windowTop + HEADER_ZONE_HEIGHT;
  return isInHeaderZone && !layout.chatLists.some((list) => isWithinRef(element, list));
}

async function requireConversationHeader(context, layout, chatName) {
  const { elements } = await findInWindow(context, { text: chatName, exact: true, max_results: 50 });
  if (!elements.some((element) => isConversationHeader(element, layout, chatName))) {
    throw new PluginError(`The open WhatsApp conversation's header does not read "${chatName}"; nothing was sent`, { kind: "not_found" });
  }
}

async function findComposer(context, layout) {
  const { elements } = await findInWindow(context, { roles: COMPOSER_ROLES });
  const candidates = elements.filter((element) => hasFrame(element) && frameOf(element).left >= layout.sidebarRight);
  const composer = candidates.sort((first, second) => frameOf(second).bottom - frameOf(first).bottom)[0];
  if (!composer) throw new PluginError("Could not find WhatsApp's message box in the open conversation; nothing was typed", { kind: "not_found" });
  return composer;
}

async function focusEmptyComposer(context, layout) {
  const composer = await findComposer(context, layout);
  await runScript(context, "focus_element", { ref: composer.ref });
  const focused = await runScript(context, "read_focused_element", {});
  const composerFocus = focusIdentityOf(composer);
  if (!matchesFocusIdentity(focused, composerFocus)) {
    throw new PluginError(`WhatsApp's message box did not take focus (focus is on ${describeElement(focused)}); nothing was typed`, { kind: "plugin_error" });
  }
  if (typeof focused.full_value === "string" && focused.full_value.trim()) {
    throw new PluginError("WhatsApp's message box already holds an unsent draft; clear it first (nothing was typed)", { kind: "invalid_input" });
  }
  return { composer, composerFocus };
}

// ---------- operation ----------

function validateSendArguments(args) {
  const chatName = args.chat.trim();
  if (!chatName || chatName.length > MAX_CHAT_NAME_LENGTH) throw new PluginError(`\`chat\` must be 1-${MAX_CHAT_NAME_LENGTH} characters`, { kind: "invalid_input" });
  if (!args.text.trim()) throw new PluginError("`text` is empty", { kind: "invalid_input" });
  return { chatName, text: normalizeLineEndings(requireTextWithinLimit("text", args.text)) };
}

// The bundle id names the real WhatsApp even if another app copies its name; use it when it is allowed.
function resolveWhatsAppAppName(client) {
  if (client.allowedApps.appNames.has(normalizeAppKey(WHATSAPP_BUNDLE_ID))) return WHATSAPP_BUNDLE_ID;
  return client.requireApp(WHATSAPP_APP_NAME);
}

async function sendWhatsAppDesktopMessage({ client, args, signal }) {
  const { chatName, text } = validateSendArguments(args);
  const context = { client, signal, appName: resolveWhatsAppAppName(client) };
  await runScript(context, "focus_app", {});
  const searchField = await searchForChat(context, chatName);
  const layout = await readLayout(context, searchField);
  const chatRow = await findChatRow(context, layout, chatName);
  await runScript(context, "click_element", { ref: chatRow.ref, fallback_click: true });
  await client.sleep(CHAT_OPEN_WAIT_MS, signal);
  await requireConversationHeader(context, layout, chatName);
  const { composer, composerFocus } = await focusEmptyComposer(context, layout);
  await insertText(context, text, composerFocus);
  await requireConversationHeader(context, layout, chatName);
  await pressKeys(context, "enter", composerFocus);
  client.logAction("whatsapp_desktop_send", { chat: chatName, characters: text.length, sent: true });
  return { data: { chat: chatName, sent: true, characters: text.length, chat_element: chatRow.ref, composer_ref: composer.ref, delivery_confirmed: false } };
}

export const whatsappOperations = [
  {
    name: "whatsapp_desktop_send",
    title: "Send WhatsApp Desktop message",
    description:
      "Workflow node only: send a message in the WhatsApp for Mac app to an existing chat, by its exact name. Opens search, requires exactly one chat-list match, checks the conversation header and the empty message box, inserts the message and presses Return. Takes keyboard focus for a few seconds. Needs WhatsApp (or net.whatsapp.WhatsApp) in COMPUTER_CONTROL_ALLOWED_APPS. Never retried automatically.",
    nodeOnly: true,
    parameters: {
      type: "object",
      properties: {
        chat: { type: "string", description: "Exact chat or contact name as shown in WhatsApp" },
        text: { type: "string", description: "Message text; \"\\n\" becomes a line break" },
      },
      required: ["chat", "text"],
    },
    run: sendWhatsAppDesktopMessage,
  },
];
