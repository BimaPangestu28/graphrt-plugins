/**
 * The operations that produce a document: render_pdf (layout templates),
 * fill_pdf_form (fillable PDFs) and fill_docx (Word templates). Each reads
 * its inputs from the allowed directories, does the heavy work in the
 * worker process and files the result under DOCUMENT_TEMPLATES_OUTPUT_DIR.
 */
import { invalidInput } from "../lib/errors.mjs";
import { Scope, interpolate } from "../lib/expressions.mjs";
import { CALCULATE_PARAMETER, VALUES_PARAMETERS, prepareValues, readValues, summariseTotals } from "../lib/document-values.mjs";
import { expandLayout, listMissingFields } from "../lib/layout-template.mjs";
import { FILING_PARAMETERS, assertIfExistsAllowed, buildFilingTokens, resolveFilingPlan } from "../lib/output-organiser.mjs";
import { assertRasterFormat } from "../lib/raster-format.mjs";
import { resolveTemplate } from "../lib/template-library.mjs";

const MAX_FORM_FIELDS = 2000;

async function readPdfInput(client, rawPath, parameterName) {
  const file = await client.fileAccess.readInputFile(rawPath, { parameterName });
  // The header may follow up to 1 KiB of junk, which readers accept too.
  if (!file.bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) throw invalidInput(`\`${parameterName}\` is not a PDF file (no %PDF- header)`);
  return file.bytes;
}

async function readImages(client, imagePaths) {
  const images = [];
  for (const imagePath of imagePaths) {
    const file = await client.fileAccess.readInputFile(imagePath, { parameterName: "image" });
    assertRasterFormat(file.bytes, ["png", "jpeg"], `The image ${JSON.stringify(imagePath)}`);
    images.push(file.bytes);
  }
  return images;
}

// Resolved and checked before the document is drawn, so a bad folder, a taken file name or a missing output folder fails fast.
async function planFiling(client, args, { values, templateName, extension }) {
  const filing = buildFilingTokens({ values, templateName, now: client.now() });
  const plan = resolveFilingPlan({ folder: args.folder, fileName: args.file_name, extension, filing });
  await client.organiser.assertCanSave({ plan, ifExists: args.if_exists });
  return plan;
}

function describeResult(savedFile, { template, values, settings, isCalculated }) {
  return {
    ...savedFile,
    template: template.name,
    number: values.number ?? null,
    ...(isCalculated ? { totals: summariseTotals(values, settings) } : {}),
  };
}

const renderPdfOperation = {
  name: "render_pdf",
  title: "Create a PDF from a template",
  description: "Creates a PDF from a layout template and values: the built-in `invoice`, or your own .json layout template. Totals are calculated for you, the table continues over pages, and the PDF is saved as <folder>/<file_name>.pdf (default 2026/11/INV-2026-0001.pdf). An existing file is never replaced unless a node asks",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", default: "invoice", description: "Built-in template name (invoice) or a .json layout template inside DOCUMENT_TEMPLATES_INPUT_DIRS" },
      ...VALUES_PARAMETERS,
      calculate: CALCULATE_PARAMETER,
      background: { type: "string", description: "A PDF inside DOCUMENT_TEMPLATES_INPUT_DIRS drawn under every page, e.g. your letterhead (its page 1 under the first page, its page 2, if any, under the others)" },
      ...FILING_PARAMETERS,
    },
  },
  run: async ({ client, args, signal, source }) => {
    assertIfExistsAllowed(args.if_exists, source);
    const template = await resolveTemplate(client, args.template, ["layout"]);
    const rawValues = await readValues(client, args);
    // Checked on the values as given, so the message names what to add before any amount is calculated.
    const missingFields = listMissingFields(template.layout, rawValues);
    if (missingFields.length > 0) throw invalidInput(`The ${template.name} template needs these values: ${missingFields.join(", ")}. describe_template shows every field with an example`);
    const prepared = prepareValues(rawValues, { calculate: args.calculate, templateCalculates: template.layout.calculate === "invoice", now: client.now() });
    const plan = expandLayout(template.layout, prepared.values, prepared.settings, { today: prepared.today });
    const filingPlan = await planFiling(client, args, { values: prepared.values, templateName: template.name, extension: "pdf" });
    const images = await readImages(client, plan.imagePaths);
    const backgroundPath = args.background ?? plan.page.background_pdf;
    const backgroundPdf = backgroundPath ? await readPdfInput(client, backgroundPath, "background") : null;
    const { data, outputs } = await client.runTask("render_layout", { plan, images, backgroundPdf, extraFontPaths: client.settings.extraFontPaths, maxPages: client.settings.maxPages }, signal);
    const savedFile = await client.organiser.saveDocument({ plan: filingPlan, bytes: Buffer.from(outputs[0]), ifExists: args.if_exists });
    return { data: { ...describeResult(savedFile, { template, ...prepared }), page_count: data.page_count } };
  },
};

async function readFieldMap(client, args) {
  if (args.fields !== undefined && args.fields_file !== undefined) throw invalidInput("Pass `fields` or `fields_file`, not both");
  if (args.fields === undefined && args.fields_file === undefined) throw invalidInput("`fields` is required: an object of form field names and their values (describe_template lists the names)");
  const fieldMap = args.fields ?? (await readValues(client, { values_file: args.fields_file }));
  const entries = Object.entries(fieldMap);
  if (entries.length === 0 || entries.length > MAX_FORM_FIELDS) throw invalidInput(`\`fields\` must name 1 to ${MAX_FORM_FIELDS} form fields`);
  return entries;
}

// A field value is a text with optional {{placeholders}} from `values`, a number or a boolean (check boxes).
function fillFieldValues(fieldEntries, prepared) {
  const scope = new Scope({ ...prepared.values, today: prepared.today });
  return Object.fromEntries(fieldEntries.map(([name, value]) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) throw invalidInput(`The value for the form field ${JSON.stringify(name)} must be a text, a number or true/false`);
    return [name, typeof value === "string" ? interpolate(value, scope, prepared.settings) : value];
  }));
}

const fillPdfFormOperation = {
  name: "fill_pdf_form",
  title: "Fill in a PDF form",
  description: "Fills the form fields of a fillable PDF (AcroForm) and saves the result as a new PDF. `fields` maps field names to values; a value may use {{placeholders}} from `values`, including calculated totals such as {{totals.total | money}}. A PDF without form fields (a scan, a picture, plain pages) cannot be filled: use render_pdf",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "The fillable .pdf inside DOCUMENT_TEMPLATES_INPUT_DIRS" },
      fields: { type: "object", description: "Form field names and their values, e.g. {\"InvoiceNo\": \"{{number}}\", \"Total\": \"{{totals.total | money}}\", \"Paid\": true}" },
      fields_file: { type: "string", description: "Instead of `fields`: a .json file with the field map, inside DOCUMENT_TEMPLATES_INPUT_DIRS (reusable for every document from this form)" },
      ...VALUES_PARAMETERS,
      calculate: CALCULATE_PARAMETER,
      flatten: { type: "boolean", default: true, description: "Turn the filled fields into plain page content so the result can no longer be edited (default true)" },
      ...FILING_PARAMETERS,
    },
    required: ["template"],
  },
  run: async ({ client, args, signal, source }) => {
    assertIfExistsAllowed(args.if_exists, source);
    const template = await resolveTemplate(client, args.template, ["pdf"]);
    const fieldEntries = await readFieldMap(client, args);
    const prepared = prepareValues(await readValues(client, args, { isRequired: false }), { calculate: args.calculate, templateCalculates: null, now: client.now() });
    const fieldValues = fillFieldValues(fieldEntries, prepared);
    const filingPlan = await planFiling(client, args, { values: prepared.values, templateName: template.name, extension: "pdf" });
    const { data, outputs } = await client.runTask("fill_pdf_form", { bytes: template.bytes, fieldValues, isFlattened: args.flatten }, signal);
    const savedFile = await client.organiser.saveDocument({ plan: filingPlan, bytes: Buffer.from(outputs[0]), ifExists: args.if_exists });
    return { data: { ...describeResult(savedFile, { template, ...prepared }), ...data } };
  },
};

const fillDocxOperation = {
  name: "fill_docx",
  title: "Fill in a Word template",
  description: "Fills the {{placeholders}} of a Word template (.docx or .dotx) and saves the result as a new .docx. A table row between {{#items}} and {{/items}} repeats for every item, and totals are calculated for you. The result is a Word file, not a PDF",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "The .docx or .dotx template inside DOCUMENT_TEMPLATES_INPUT_DIRS" },
      ...VALUES_PARAMETERS,
      calculate: CALCULATE_PARAMETER,
      ...FILING_PARAMETERS,
    },
    required: ["template"],
  },
  run: async ({ client, args, signal, source }) => {
    assertIfExistsAllowed(args.if_exists, source);
    const template = await resolveTemplate(client, args.template, ["docx"]);
    const prepared = prepareValues(await readValues(client, args), { calculate: args.calculate, templateCalculates: null, now: client.now() });
    const filingPlan = await planFiling(client, args, { values: prepared.values, templateName: template.name, extension: "docx" });
    const { outputs } = await client.runTask("fill_docx", { bytes: template.bytes, values: { ...prepared.values, today: prepared.today }, settings: prepared.settings }, signal);
    const savedFile = await client.organiser.saveDocument({ plan: filingPlan, bytes: Buffer.from(outputs[0]), ifExists: args.if_exists });
    return { data: describeResult(savedFile, { template, ...prepared }) };
  },
};

export const documentOperations = [renderPdfOperation, fillPdfFormOperation, fillDocxOperation];
