/**
 * Fillable PDF forms (AcroForm) with pdf-lib: list the fields, fill them and
 * optionally flatten the form into plain page content.
 *
 * Text fields are drawn with the bundled Inter font, so values are not
 * limited to the Latin-1 characters of the PDF standard fonts. A form has a
 * fixed set of fields: it cannot grow rows for more line items than it was
 * drawn with. XFA forms (made with Adobe LiveCycle Designer) are not
 * AcroForms; when a PDF carries both, as most government forms do, the XFA
 * part is dropped so viewers show the filled AcroForm fields. A PDF that has
 * only the XFA part is refused.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { invalidInput } from "./errors.mjs";

const FORM_FONT_PATH = fileURLToPath(new URL("../fonts/Inter-Regular.ttf", import.meta.url));
const MAX_FIELDS = 2000;
const MAX_VALUE_LENGTH = 20000;
const TRUE_TEXTS = new Set(["true", "yes", "1", "on", "x", "ya"]);
const ENCRYPTED_MESSAGE = "The PDF is protected (encrypted), which many official forms are even when they open without a password, and a protected PDF cannot be filled in here. Use a copy without protection: ask whoever published the form for one, or remove the protection with a PDF program (for example `qpdf --decrypt form.pdf unprotected.pdf`)";
export const XFA_ONLY_MESSAGE = "This PDF is an XFA form (made with Adobe LiveCycle Designer; other programs show \"Please wait...\" instead of the form). XFA forms cannot be filled in here: only Adobe Acrobat reads them. Ask whoever published the form for a standard fillable PDF (AcroForm), or recreate the document as a layout template for render_pdf";

const FILLABLE_KINDS = new Set(["PDFTextField", "PDFCheckBox", "PDFDropdown", "PDFRadioGroup", "PDFOptionList"]);

async function loadForm(bytes) {
  const { PDFDict, PDFDocument, PDFName } = await import("pdf-lib");
  const document = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }).catch((loadError) => {
    throw invalidInput(`The template is not a readable PDF: ${loadError.message}`);
  });
  if (document.isEncrypted) throw invalidInput(ENCRYPTED_MESSAGE);
  // Read before getForm(), which drops the XFA part.
  const hasXfa = Boolean(document.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)?.has(PDFName.of("XFA")));
  const form = document.getForm();
  const fields = form.getFields();
  if (fields.length > MAX_FIELDS) throw invalidInput(`The PDF has ${fields.length} form fields, over the limit of ${MAX_FIELDS}`);
  // A pure XFA form has no standard fields, or only the signature field Adobe adds for signing.
  const isXfaOnly = hasXfa && !fields.some((field) => FILLABLE_KINDS.has(field.constructor.name));
  return { document, form, fields, isXfaOnly };
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
 * @returns `{data: {page_count, is_form, is_xfa_only, fields: [{name, kind, read_only, required, options?, max_length?}]}}`; an XFA-only PDF is not a form here (object)
 */
export async function inspectPdfForm({ bytes }) {
  const { document, fields, isXfaOnly } = await loadForm(bytes);
  return { data: { page_count: document.getPageCount(), is_form: fields.length > 0 && !isXfaOnly, is_xfa_only: isXfaOnly, fields: fields.map(describeField) } };
}

/**
 * Fills form fields by name.
 *
 * @param request - `{bytes, fieldValues: {name: text | number | boolean}, isFlattened}` (object)
 * @returns `{data: {page_count, filled_fields, empty_fields}, outputs: [Uint8Array]}` (object)
 * @throws PluginError kind `invalid_input` - When the PDF has no form, a name is unknown, or a value does not fit its field
 */
export async function fillPdfForm({ bytes, fieldValues, isFlattened }) {
  const { document, form, fields, isXfaOnly } = await loadForm(bytes);
  if (isXfaOnly) throw invalidInput(XFA_ONLY_MESSAGE);
  if (fields.length === 0) throw invalidInput("This PDF has no fillable form fields. A PDF that is a picture or plain page content cannot be filled in; use the built-in invoice template, or a layout template with this PDF as its background");
  const fieldsByName = new Map(fields.map((field) => [field.getName(), field]));
  const unknownNames = Object.keys(fieldValues).filter((name) => !fieldsByName.has(name));
  if (unknownNames.length > 0) throw invalidInput(`The PDF has no form field named ${unknownNames.map((name) => JSON.stringify(name)).join(", ")}. Its fields: ${[...fieldsByName.keys()].slice(0, 60).join(", ")}`);
  for (const [name, value] of Object.entries(fieldValues)) setFieldValue(fieldsByName.get(name), name, value);
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  document.registerFontkit(fontkit);
  // Tabular figures keep "1.277.000" readable (see pdf-renderer.mjs). Always a subset: pdf-lib draws a whole
  // embedded font with wrong word spaces and drops digits (seen on IRS form 1040).
  const font = await document.embedFont(await readFile(FORM_FONT_PATH), { subset: true, features: { tnum: true } });
  try {
    form.updateFieldAppearances(font);
    await drawValuesLeftToTheViewer(form, fields, font);
    if (isFlattened) {
      await giveEveryWidgetAnAppearance(document, form);
      form.flatten();
      await removeDanglingAnnotations(document);
    }
  } catch (drawError) {
    throw invalidInput(`A value could not be drawn in its field: ${drawError.message}`);
  }
  const filledNames = Object.keys(fieldValues);
  return {
    data: { page_count: document.getPageCount(), filled_fields: filledNames, empty_fields: [...fieldsByName.keys()].filter((name) => !filledNames.includes(name)), flattened: isFlattened },
    outputs: [await document.save()],
  };
}

// A form flagged NeedAppearances leaves the drawing of its values to the viewer, so values it came with may have
// no drawing of their own and would vanish when flattened. Every field is drawn here and the flag removed; it
// stays when a field cannot be drawn (rich text), so a viewer still does it.
async function drawValuesLeftToTheViewer(form, fields, font) {
  const { PDFBool, PDFName } = await import("pdf-lib");
  const flagName = PDFName.of("NeedAppearances");
  if (form.acroForm.dict.lookup(flagName) !== PDFBool.True) return;
  let isEveryFieldDrawn = true;
  for (const field of fields) {
    if (!FILLABLE_KINDS.has(field.constructor.name)) continue;
    try {
      field.defaultUpdateAppearances(font);
    } catch {
      isEveryFieldDrawn = false;
    }
  }
  if (isEveryFieldDrawn) form.acroForm.dict.delete(flagName);
}

// pdf-lib's flatten() stops at a widget that has nothing to draw: an unsigned signature field, a push button or
// a check box without a drawing for its state, which real forms have. Such a widget gets an empty drawing.
async function giveEveryWidgetAnAppearance(document, form) {
  const { PDFName } = await import("pdf-lib");
  for (const field of form.getFields()) {
    for (const widget of field.acroField.getWidgets()) {
      if (hasAppearance(form, field, widget)) continue;
      const { width, height } = widget.getRectangle();
      const emptyDrawing = document.context.register(document.context.formXObject([], { BBox: document.context.obj([0, 0, width, height]) }));
      widget.dict.set(PDFName.of("AP"), document.context.obj({ N: emptyDrawing }));
    }
  }
}

function hasAppearance(form, field, widget) {
  try {
    return Boolean(form.findWidgetAppearanceRef(field, widget));
  } catch {
    return false;
  }
}

// pdf-lib's flatten() deletes the field widgets but can leave them listed in a page's /Annots; strict readers
// (poppler: "Invalid XRef entry") then complain about the saved file.
async function removeDanglingAnnotations(document) {
  const { PDFArray, PDFName, PDFRef } = await import("pdf-lib");
  const annotationsKey = PDFName.of("Annots");
  for (const page of document.getPages()) {
    const annotations = page.node.lookupMaybe(annotationsKey, PDFArray);
    if (!annotations) continue;
    const kept = annotations.asArray().filter((entry) => !(entry instanceof PDFRef) || document.context.lookup(entry) !== undefined);
    if (kept.length === 0) page.node.delete(annotationsKey);
    else if (kept.length < annotations.size()) page.node.set(annotationsKey, document.context.obj(kept));
  }
}

// pdf-lib accepts any text for a drop-down by quietly making it a free-text field; a form that offers a fixed
// list gets only values from that list.
function selectDropdownOption(field, text) {
  const dropdownOptions = field.getOptions();
  if (!field.isEditable() && !dropdownOptions.includes(text)) throw new Error(`${JSON.stringify(text)} is not one of its options (${dropdownOptions.slice(0, 40).map((option) => JSON.stringify(option)).join(", ")})`);
  field.select(text);
}

function setFieldValue(field, name, value) {
  const kind = field.constructor.name;
  const text = value === null || value === undefined ? "" : String(value);
  if (text.length > MAX_VALUE_LENGTH) throw invalidInput(`The value for ${JSON.stringify(name)} is longer than ${MAX_VALUE_LENGTH} characters`);
  try {
    if (kind === "PDFTextField") field.setText(text);
    else if (kind === "PDFCheckBox") (value === true || TRUE_TEXTS.has(text.trim().toLowerCase()) ? field.check() : field.uncheck());
    else if (kind === "PDFDropdown") selectDropdownOption(field, text);
    else if (kind === "PDFRadioGroup") field.select(text);
    else if (kind === "PDFOptionList") field.select(Array.isArray(value) ? value.map(String) : text);
    else throw new Error(`fields of kind ${kind.replace(/^PDF/, "")} cannot be filled`);
  } catch (setError) {
    throw invalidInput(`The value for the form field ${JSON.stringify(name)} was not accepted: ${setError.message}`);
  }
}
