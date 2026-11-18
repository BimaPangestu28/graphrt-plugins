/**
 * Builders for interactive reply-button and list messages, enforcing the
 * Cloud API limits locally so mistakes fail fast with a clear message
 * instead of a generic (#131009) from WhatsApp.
 *
 * Limits (developers.facebook.com/docs/whatsapp/cloud-api/messages/...):
 * - reply buttons: 1-3 buttons, title <= 20 chars and unique, id <= 256, body <= 1024
 * - list: <= 10 sections, 1-10 rows in total, row title <= 24, description <= 72,
 *   row id <= 200, button text <= 20, section title <= 24 (required with >1 section), body <= 4096
 * - header text and footer <= 60
 */
import { checkMaxLength, rejectInput } from "./client.mjs";

const MAX_BUTTONS = 3;
const MAX_SECTIONS = 10;
const MAX_ROWS = 10;

/**
 * Builds the `interactive` object for a reply-buttons message.
 *
 * @param args - `{body, buttons, header_text, footer}`; buttons are strings or `{id, title}` (object)
 * @returns Interactive object (object)
 * @throws PluginError kind `invalid_input` - When a limit is exceeded
 */
export function buildButtonsInteractive(args) {
  checkMaxLength(args.body, 1024, "body");
  const buttons = args.buttons.map(normalizeButton);
  if (buttons.length < 1 || buttons.length > MAX_BUTTONS) rejectInput(`\`buttons\` must have 1 to ${MAX_BUTTONS} buttons; WhatsApp allows at most 3`);
  if (new Set(buttons.map((button) => button.title)).size !== buttons.length) rejectInput("Button titles must be unique");
  return withHeaderAndFooter({ type: "button" }, args, {
    action: { buttons: buttons.map((button) => ({ type: "reply", reply: button })) },
  });
}

function normalizeButton(button, index) {
  const normalizedButton = typeof button === "string" ? { id: button, title: button } : { id: button?.id, title: button?.title };
  if (!normalizedButton.id || !normalizedButton.title) rejectInput(`\`buttons[${index}]\` needs an \`id\` and a \`title\` (or pass a plain string)`);
  checkMaxLength(normalizedButton.title, 20, `buttons[${index}].title`);
  checkMaxLength(normalizedButton.id, 256, `buttons[${index}].id`);
  return { id: String(normalizedButton.id), title: String(normalizedButton.title) };
}

/**
 * Builds the `interactive` object for a list message.
 *
 * @param args - `{body, button_text, sections, header_text, footer}` (object)
 * @returns Interactive object (object)
 * @throws PluginError kind `invalid_input` - When a limit is exceeded
 */
export function buildListInteractive(args) {
  checkMaxLength(args.body, 4096, "body");
  checkMaxLength(args.button_text, 20, "button_text");
  if (args.sections.length < 1 || args.sections.length > MAX_SECTIONS) rejectInput(`\`sections\` must have 1 to ${MAX_SECTIONS} sections`);
  const sections = args.sections.map((section, index) => normalizeSection(section, index, args.sections.length > 1));
  const rowCount = sections.reduce((total, section) => total + section.rows.length, 0);
  if (rowCount > MAX_ROWS) rejectInput(`A list can have at most ${MAX_ROWS} rows in total, got ${rowCount}`);
  return withHeaderAndFooter({ type: "list" }, args, { action: { button: args.button_text, sections } });
}

function normalizeSection(section, sectionIndex, isTitleRequired) {
  const rows = Array.isArray(section?.rows) ? section.rows : [];
  if (rows.length === 0) rejectInput(`\`sections[${sectionIndex}]\` needs at least one row`);
  if (isTitleRequired && !section.title) rejectInput(`\`sections[${sectionIndex}].title\` is required when there is more than one section`);
  checkMaxLength(section.title, 24, `sections[${sectionIndex}].title`);
  const normalizedSection = { rows: rows.map((row, rowIndex) => normalizeRow(row, `sections[${sectionIndex}].rows[${rowIndex}]`)) };
  return section.title ? { title: String(section.title), ...normalizedSection } : normalizedSection;
}

function normalizeRow(row, rowPath) {
  if (!row?.id || !row?.title) rejectInput(`\`${rowPath}\` needs an \`id\` and a \`title\``);
  checkMaxLength(row.id, 200, `${rowPath}.id`);
  checkMaxLength(row.title, 24, `${rowPath}.title`);
  checkMaxLength(row.description, 72, `${rowPath}.description`);
  const normalizedRow = { id: String(row.id), title: String(row.title) };
  if (row.description) normalizedRow.description = String(row.description);
  return normalizedRow;
}

function withHeaderAndFooter(interactiveBase, args, actionPart) {
  checkMaxLength(args.header_text, 60, "header_text");
  checkMaxLength(args.footer, 60, "footer");
  const interactive = { ...interactiveBase };
  if (args.header_text) interactive.header = { type: "text", text: args.header_text };
  interactive.body = { text: args.body };
  if (args.footer) interactive.footer = { text: args.footer };
  return { ...interactive, ...actionPart };
}
