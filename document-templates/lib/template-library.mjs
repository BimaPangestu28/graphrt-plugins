/**
 * Finds the template a call names: a built-in layout that ships with the
 * plugin (templates/*.json), or a file inside the allowed input directories
 * (a layout .json, a Word .docx or .dotx, or a PDF form).
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { invalidInput } from "./errors.mjs";
import { parseLayoutTemplate } from "./layout-template.mjs";

export const BUILT_IN_TEMPLATE_NAMES = ["invoice"];
const TEMPLATE_DIRECTORY = new URL("../templates/", import.meta.url);
// .dotx is the format Word saves templates in, and the one Microsoft's own templates are downloaded as.
const KINDS_BY_EXTENSION = { json: "layout", docx: "docx", dotx: "docx", pdf: "pdf" };
const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;

/**
 * Reads a built-in layout template.
 *
 * @param name - One of BUILT_IN_TEMPLATE_NAMES (string)
 * @returns The parsed template (object)
 */
export async function loadBuiltInTemplate(name) {
  const text = await readFile(fileURLToPath(new URL(`${name}.json`, TEMPLATE_DIRECTORY)), "utf8");
  return parseLayoutTemplate(text, name);
}

/**
 * Resolves a `template` argument.
 *
 * @param client - From createDocumentClient (object)
 * @param templateArgument - Built-in name or file path (string)
 * @param allowedKinds - Kinds the operation accepts: "layout", "docx", "pdf" (string[])
 * @returns `{kind, name, isBuiltIn, layout?, bytes?, path?}` (object)
 * @throws PluginError kinds `invalid_input` (wrong kind of file), `not_found` (missing or outside the allowed directories)
 */
export async function resolveTemplate(client, templateArgument, allowedKinds) {
  const trimmed = String(templateArgument).trim();
  if (BUILT_IN_TEMPLATE_NAMES.includes(trimmed.toLowerCase())) {
    if (!allowedKinds.includes("layout")) throw wrongKind(trimmed, "layout", allowedKinds);
    return { kind: "layout", name: trimmed.toLowerCase(), isBuiltIn: true, layout: await loadBuiltInTemplate(trimmed.toLowerCase()) };
  }
  const extension = extname(trimmed).slice(1).toLowerCase();
  const kind = KINDS_BY_EXTENSION[extension];
  if (!kind) throw invalidInput(`\`template\` must be a built-in template (${BUILT_IN_TEMPLATE_NAMES.join(", ")}) or a .json, .docx, .dotx or .pdf file, got ${JSON.stringify(trimmed)}`);
  if (!allowedKinds.includes(kind)) throw wrongKind(trimmed, kind, allowedKinds);
  const file = await client.fileAccess.readInputFile(trimmed, { parameterName: "template", extensions: [extension] });
  const name = trimmed.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  if (kind !== "layout") return { kind, name, isBuiltIn: false, bytes: file.bytes, path: file.path };
  if (file.bytes.length > MAX_LAYOUT_BYTES) throw invalidInput(`The layout template is ${file.bytes.length} bytes, over the limit of ${MAX_LAYOUT_BYTES}`);
  return { kind, name, isBuiltIn: false, path: file.path, layout: parseLayoutTemplate(file.bytes.toString("utf8"), name) };
}

const KIND_HINTS = {
  layout: { what: "a layout template", operation: "render_pdf" },
  docx: { what: "a Word document", operation: "fill_docx" },
  pdf: { what: "a PDF", operation: "fill_pdf_form" },
};

function wrongKind(templateArgument, kind, allowedKinds) {
  return invalidInput(`${JSON.stringify(templateArgument)} is ${KIND_HINTS[kind].what}; this operation takes ${allowedKinds.map((allowed) => KIND_HINTS[allowed].what).join(" or ")}. Use ${KIND_HINTS[kind].operation} for it`);
}
