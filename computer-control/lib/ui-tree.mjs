/**
 * Element refs and the compact text rendering of Accessibility elements.
 *
 * A ref is the child-index path from a window plus a fingerprint: `w1` is the
 * first window, `w1/3/2` its 3rd child's 2nd child (all 1-based), and
 * `w1/3/2#0a1b2c3` adds a hash of the element's role, subrole, title,
 * description and placeholder (and value, for static text), computed by
 * jxa/prelude.js. Refs are re-resolved on every use; a path that no longer
 * exists, or now leads to an element with another fingerprint, fails with
 * `not_found` ("read_ui again"), so a shifted UI never redirects an action.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const ELEMENT_REF_PATTERN = /^w[1-9]\d{0,2}(\/[1-9]\d{0,4}){0,60}(#[0-9a-z]{7})?$/;
const FINGERPRINT_SEPARATOR = "#";
const MAX_INLINE_TEXT = 80;
const INDENT = "  ";
/** Budget for data.text plus the JSON of data.elements in read_ui / find_elements output. */
export const MAX_OUTLINE_OUTPUT_CHARACTERS = 60000;

/**
 * Validates an element ref such as `w1/3/2#0a1b2c3`.
 *
 * @param ref - Ref from read_ui or find_elements (string)
 * @param options - Validation options (object)
 * @param options.requireFingerprint - Require the `#fingerprint` part, for operations that act on the element (boolean, default false)
 * @returns The trimmed ref (string)
 * @throws PluginError kind `invalid_input`
 *
 * @example
 * validateElementRef("w1/3/2#0a1b2c3", { requireFingerprint: true }); // "w1/3/2#0a1b2c3"
 */
export function validateElementRef(ref, { requireFingerprint = false } = {}) {
  const trimmedRef = String(ref ?? "").trim();
  if (!ELEMENT_REF_PATTERN.test(trimmedRef)) {
    throw new PluginError(`\`ref\` must look like "w1/3/2#0a1b2c3" (from read_ui or find_elements), got "${trimmedRef.slice(0, 40)}"`, {
      kind: "invalid_input",
    });
  }
  if (requireFingerprint && !trimmedRef.includes(FINGERPRINT_SEPARATOR)) {
    throw new PluginError(`\`ref\` "${trimmedRef}" has no #fingerprint: pass it exactly as read_ui or find_elements returned it`, {
      kind: "invalid_input",
    });
  }
  return trimmedRef;
}

/**
 * Returns the child-index path of a ref, without its fingerprint.
 *
 * @param ref - Ref such as `w1/3/2#0a1b2c3` (string)
 * @returns Path such as `w1/3/2` (string)
 */
export function stripRefFingerprint(ref) {
  return String(ref).split(FINGERPRINT_SEPARATOR)[0];
}

/**
 * Normalises a role filter: "button" and "AXButton" both become "AXButton".
 *
 * @param role - Role name (string | undefined)
 * @returns Role with the AX prefix, or undefined (string | undefined)
 */
export function normalizeRole(role) {
  if (!role) return undefined;
  const trimmedRole = role.trim();
  if (/^ax/i.test(trimmedRole)) return `AX${trimmedRole.slice(2)}`;
  return `AX${trimmedRole.charAt(0).toUpperCase()}${trimmedRole.slice(1)}`;
}

/**
 * Formats one element as a single line, e.g. `w1/2 Button "Send" @10,20 80x24`.
 *
 * @param element - Element record from a JXA script (object)
 * @returns One line without indentation (string)
 */
export function formatElementLine(element) {
  const parts = [element.ref, describeRole(element)];
  if (element.title) parts.push(quote(element.title));
  if (hasValue(element.value)) parts.push(`value=${quote(String(element.value))}`);
  if (element.description && element.description !== element.title) parts.push(`desc=${quote(element.description)}`);
  if (element.placeholder) parts.push(`placeholder=${quote(element.placeholder)}`);
  if (element.enabled === false) parts.push("[disabled]");
  if (element.focused) parts.push("[focused]");
  if (element.position && element.size) parts.push(`@${element.position.join(",")} ${element.size.join("x")}`);
  return parts.join(" ");
}

/**
 * Renders elements as an indented outline with a one-line header.
 *
 * @param header - First line, e.g. `Finder window 1` (string)
 * @param snapshot - `{elements, truncated, depth_limited}` from read_ui/find_elements (object)
 * @param options - `{indent}`: indent by depth (object, default true)
 * @returns Text for agents (string)
 */
export function renderElementOutline(header, snapshot, { indent = true } = {}) {
  return buildOutlineOutput(header, snapshot, { indent, maxCharacters: Infinity }).text;
}

/**
 * Builds read_ui / find_elements output: the outline text plus the structured elements, cut so that
 * both together stay within `maxCharacters` (tool output carries both). The text says when it was cut.
 *
 * @param header - First line, e.g. `Finder w1` (string)
 * @param snapshot - `{elements, truncated, depth_limited}` from read_ui/find_elements (object)
 * @param options - Rendering options (object)
 * @param options.indent - Indent lines by depth (boolean, default true)
 * @param options.maxCharacters - Budget for text plus elements JSON (number, default MAX_OUTLINE_OUTPUT_CHARACTERS)
 * @returns `{text, elements, output_truncated}` (object)
 *
 * @example
 * const { text, elements, output_truncated } = buildOutlineOutput("Finder w1", snapshot);
 */
export function buildOutlineOutput(header, snapshot, { indent = true, maxCharacters = MAX_OUTLINE_OUTPUT_CHARACTERS } = {}) {
  const elements = snapshot.elements ?? [];
  const baseDepth = elements.length ? Math.min(...elements.map((element) => element.depth ?? 0)) : 0;
  const keptElements = [];
  const lines = [];
  let usedCharacters = header.length + RESERVED_NOTE_CHARACTERS;
  for (const element of elements) {
    const line = `${indent ? INDENT.repeat((element.depth ?? 0) - baseDepth) : ""}${formatElementLine(element)}`;
    const cost = line.length + JSON.stringify(element).length + 2;
    if (usedCharacters + cost > maxCharacters) break;
    usedCharacters += cost;
    keptElements.push(element);
    lines.push(line);
  }
  const outputTruncated = keptElements.length < elements.length;
  const notes = describeLimits(snapshot);
  if (outputTruncated) {
    notes.push(`… output cut at ${maxCharacters} characters after ${keptElements.length} of ${elements.length} elements: pass root_ref, text_only or a lower max_elements`);
  }
  const text = [`${header} — ${elements.length} element(s)`, ...lines, ...notes].join("\n");
  return { text, elements: keptElements, output_truncated: outputTruncated };
}

const RESERVED_NOTE_CHARACTERS = 400;

function describeLimits(snapshot) {
  const notes = [];
  if (snapshot.truncated) notes.push("… truncated: raise max_elements/max_results, or pass root_ref to read one sub-tree");
  if (snapshot.depth_limited) notes.push("… some branches are deeper than max_depth: pass a deeper ref as root_ref to read them");
  return notes;
}

function describeRole(element) {
  const role = String(element.role ?? "AXUnknown").replace(/^AX/, "");
  return element.subrole ? `${role}(${String(element.subrole).replace(/^AX/, "")})` : role;
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function quote(text) {
  const singleLine = String(text).replace(/\s+/g, " ").trim();
  return JSON.stringify(singleLine.length > MAX_INLINE_TEXT ? `${singleLine.slice(0, MAX_INLINE_TEXT)}…` : singleLine);
}
