/**
 * Plugin settings as people see them: `graphrt-settings.json`, an optional file next to a plugin's
 * `graphrt-plugin.json`.
 *
 * A manifest only lists the names of the environment variables a plugin may read (`permissions.env`). This file
 * says, per variable, what to call it, what it is for, what kind of value it takes, whether it has to be filled
 * in and what its default is, so graphrt Desktop can show a labelled form (a folder picker, a number field)
 * instead of raw variable names. The graphrt runtime does not read the file. The catalog repeats its valid
 * items as `settings` on the plugin's entry of `index.json` and `index-v2.json`, for plugins that are not
 * installed yet; the file in the tarball is the one source.
 *
 *   { "settings": [ { "name": "DOCUMENT_TEMPLATES_OUTPUT_DIR", "label": "Folder for finished documents",
 *                     "help": "Where your documents are saved.", "kind": "folder", "required": true } ] }
 *
 * Item fields (only `name` is needed):
 * - `name`: a variable of the manifest's `permissions.env`
 * - `label`: what the setting is called, at most 80 characters
 * - `help`: one or two sentences, at most 300 characters, without variable names
 * - `kind`: `text` (default), `secret` (hidden), `number`, `folder` or `file`
 * - `required`: true when the plugin cannot work without it (default false)
 * - `default`: the value the plugin uses when the setting is empty; a setting with a default is never required
 * - `multiple`: true when the value is a comma-separated list (default false)
 */
export const SETTINGS_FILE_NAME = "graphrt-settings.json";
export const MAX_SETTINGS_FILE_BYTES = 64 * 1024;
export const MAX_SETTING_LABEL_LENGTH = 80;
export const MAX_SETTING_HELP_LENGTH = 300;
export const SETTING_KINDS = Object.freeze(["text", "secret", "number", "folder", "file"]);

const ITEM_KEYS = new Set(["name", "label", "help", "kind", "required", "default", "multiple"]);
const DEFAULT_TYPES = new Set(["string", "number", "boolean"]);
// Two or more upper-case words joined by underscores: how environment variables are written.
const VARIABLE_NAME_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

/**
 * Lists what is wrong with one settings item.
 *
 * @param item - An entry of `settings` (any)
 * @param permittedNames - The manifest's `permissions.env` (string[])
 * @returns Problems, empty when the item is valid (string[])
 */
export function findSettingProblems(item, permittedNames) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return ["must be an object"];
  if (typeof item.name !== "string" || item.name === "") return ["needs a `name`"];
  const problems = [];
  if (!permittedNames.includes(item.name)) problems.push("`name` is not in the manifest's permissions.env");
  for (const key of Object.keys(item)) {
    if (!ITEM_KEYS.has(key)) problems.push(`unknown field \`${key}\``);
  }
  for (const [field, maxLength] of [["label", MAX_SETTING_LABEL_LENGTH], ["help", MAX_SETTING_HELP_LENGTH]]) {
    const text = item[field];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.trim() === "") problems.push(`\`${field}\` must be a text`);
    else if ([...text].length > maxLength) problems.push(`\`${field}\` is longer than ${maxLength} characters`);
    else if (VARIABLE_NAME_PATTERN.test(text)) problems.push(`\`${field}\` must not name a variable (${VARIABLE_NAME_PATTERN.exec(text)[0]}); say what the setting is for`);
  }
  if (item.kind !== undefined && !SETTING_KINDS.includes(item.kind)) problems.push(`\`kind\` must be one of ${SETTING_KINDS.join(", ")}`);
  for (const field of ["required", "multiple"]) {
    if (item[field] !== undefined && typeof item[field] !== "boolean") problems.push(`\`${field}\` must be true or false`);
  }
  if (item.default !== undefined) {
    if (!DEFAULT_TYPES.has(typeof item.default)) problems.push("`default` must be a text, a number or true/false");
    else if (item.kind === "number" && typeof item.default !== "number") problems.push("`default` of a number setting must be a number");
    if (item.required === true) problems.push("a setting with a `default` is never required; remove `required` or `default`");
    if (item.kind === "secret") problems.push("a secret has no `default`");
  }
  return problems;
}

/**
 * Reads the text of a `graphrt-settings.json`.
 *
 * @param settingsText - The file's text (string)
 * @param permittedNames - The manifest's `permissions.env` (string[])
 * @returns `{settings, problems}`: the valid items in file order, and every problem as "<name or position>: <what>";
 *   a file that is not usable at all has no settings (object)
 */
export function parsePluginSettings(settingsText, permittedNames) {
  if (Buffer.byteLength(settingsText) > MAX_SETTINGS_FILE_BYTES) return { settings: [], problems: [`the file is larger than ${MAX_SETTINGS_FILE_BYTES} bytes`] };
  let document;
  try {
    document = JSON.parse(settingsText);
  } catch (parseError) {
    return { settings: [], problems: [`not valid JSON: ${parseError.message}`] };
  }
  if (document === null || typeof document !== "object" || !Array.isArray(document.settings)) return { settings: [], problems: ["must be an object with a `settings` list"] };
  const settings = [];
  const problems = Object.keys(document).filter((key) => key !== "settings").map((key) => `unknown field \`${key}\``);
  const seenNames = new Set();
  document.settings.forEach((item, index) => {
    const itemProblems = findSettingProblems(item, permittedNames);
    if (itemProblems.length === 0 && seenNames.has(item.name)) itemProblems.push("is listed twice");
    const itemName = typeof item?.name === "string" && item.name !== "" ? item.name : `settings[${index}]`;
    problems.push(...itemProblems.map((problem) => `${itemName}: ${problem}`));
    if (itemProblems.length > 0) return;
    seenNames.add(item.name);
    settings.push(item);
  });
  return { settings, problems };
}
