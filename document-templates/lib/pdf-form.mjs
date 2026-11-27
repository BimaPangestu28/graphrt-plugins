/**
 * Fillable PDF forms (AcroForm) with pdf-lib: list the fields, fill them and
 * optionally flatten the form into plain page content.
 *
 * Text fields are drawn with the bundled Inter font, so values are not
 * limited to the Latin-1 characters of the PDF standard fonts. A form has a
 * fixed set of fields: it cannot grow rows for more line items than it was
 * drawn with. XFA forms (made with Adobe LiveCycle) are not AcroForms; when a
 * PDF carries both, the XFA part is dropped so viewers show the filled
 * AcroForm fields.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { invalidInput } from "./errors.mjs";

const FORM_FONT_PATH = fileURLToPath(new URL("../fonts/Inter-Regular.ttf", import.meta.url));
const MAX_FIELDS = 2000;
const MAX_VALUE_LENGTH = 20000;
const TRUE_TEXTS = new Set(["true", "yes", "1", "on", "x", "ya"]);

async function loadForm(bytes) {
  const { PDFDocument } = await import("pdf-lib");
  const document = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }).catch((loadError) => {
    throw invalidInput(`The template is not a readable PDF: ${loadError.message}`);
  });
  if (document.isEncrypted) throw invalidInput("The PDF is encrypted; save an unprotected copy first");
  const form = document.getForm();
  const fields = form.getFields();
  if (fields.length > MAX_FIELDS) throw invalidInput(`The PDF has ${fields.length} form fields, over the limit of ${MAX_FIELDS}`);
  return { document, form, fields };
}

function describeField(field) {
  const kind = field.constructor.name.replace(/^PDF/, "").replace(/Field$/, "").toLowerCase();
  const description = { name: field.getName(), kind, read_only: field.isReadOnly(), required: field.isRequired() };
  if (typeof field.getOptions === "function") description.options = field.getOptions();
  if (kind === "text") description.max_length = field.getMaxLength() ?? null;
  return description;
}

/**
 * Lists a PDF's form fields.
 *
 * @param request - `{bytes}` (object)
 * @returns `{data: {page_count, is_form, fields: [{name, kind, read_only, required, options?, max_length?}]}}` (object)
 */
export async function inspectPdfForm({ bytes }) {
  const { document, fields } = await loadForm(bytes);
  return { data: { page_count: document.getPageCount(), is_form: fields.length > 0, fields: fields.map(describeField) } };
}

/**
 * Fills form fields by name.
 *
 * @param request - `{bytes, fieldValues: {name: text | number | boolean}, isFlattened}` (object)
 * @returns `{data: {page_count, filled_fields, empty_fields}, outputs: [Uint8Array]}` (object)
 * @throws PluginError kind `invalid_input` - When the PDF has no form, a name is unknown, or a value does not fit its field
 */
export async function fillPdfForm({ bytes, fieldValues, isFlattened }) {
  const { document, form, fields } = await loadForm(bytes);
  if (fields.length === 0) throw invalidInput("This PDF has no fillable form fields. A PDF that is a picture or plain page content cannot be filled in; use the built-in invoice template, or a layout template with this PDF as its background");
  const fieldsByName = new Map(fields.map((field) => [field.getName(), field]));
  const unknownNames = Object.keys(fieldValues).filter((name) => !fieldsByName.has(name));
  if (unknownNames.length > 0) throw invalidInput(`The PDF has no form field named ${unknownNames.map((name) => JSON.stringify(name)).join(", ")}. Its fields: ${[...fieldsByName.keys()].slice(0, 60).join(", ")}`);
  for (const [name, value] of Object.entries(fieldValues)) setFieldValue(fieldsByName.get(name), name, value);
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  document.registerFontkit(fontkit);
  // Tabular figures keep "1.277.000" readable (see pdf-renderer.mjs).
  const font = await document.embedFont(await readFile(FORM_FONT_PATH), { subset: true, features: { tnum: true } });
  if (form.hasXFA()) form.deleteXFA();
  try {
    form.updateFieldAppearances(font);
    if (isFlattened) form.flatten();
  } catch (drawError) {
    throw invalidInput(`A value could not be drawn in its field: ${drawError.message}`);
  }
  const filledNames = Object.keys(fieldValues);
  return {
    data: { page_count: document.getPageCount(), filled_fields: filledNames, empty_fields: [...fieldsByName.keys()].filter((name) => !filledNames.includes(name)), flattened: isFlattened },
    outputs: [await document.save()],
  };
}

function setFieldValue(field, name, value) {
  const kind = field.constructor.name;
  const text = value === null || value === undefined ? "" : String(value);
  if (text.length > MAX_VALUE_LENGTH) throw invalidInput(`The value for ${JSON.stringify(name)} is longer than ${MAX_VALUE_LENGTH} characters`);
  try {
    if (kind === "PDFTextField") field.setText(text);
    else if (kind === "PDFCheckBox") (value === true || TRUE_TEXTS.has(text.trim().toLowerCase()) ? field.check() : field.uncheck());
    else if (kind === "PDFDropdown" || kind === "PDFRadioGroup") field.select(text);
    else if (kind === "PDFOptionList") field.select(Array.isArray(value) ? value.map(String) : text);
    else throw new Error(`fields of kind ${kind.replace(/^PDF/, "")} cannot be filled`);
  } catch (setError) {
    throw invalidInput(`The value for the form field ${JSON.stringify(name)} was not accepted: ${setError.message}`);
  }
}
