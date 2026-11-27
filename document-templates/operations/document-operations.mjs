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
import { PDF_PASSWORD_PARAMETER } from "../lib/pdf-form.mjs";
import { assertRasterFormat } from "../lib/raster-format.mjs";
import { resolveTemplate } from "../lib/template-library.mjs";

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
  description: "Creates a PDF document, such as an invoice, from a template and your values: the ready-made `invoice`, or your own template. Totals are calculated for you and a long list of items continues on the next page. The PDF is saved in your documents folder, sorted by year and month (2026/11/INV-2026-0001.pdf), and a document that is already there is never replaced. The result says where the file is",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", default: "invoice", description: "`invoice` (the ready-made template), or your own template: a .json file in your templates folder, or the `path` that save_template_copy returned" },
      ...VALUES_PARAMETERS,
      calculate: CALCULATE_PARAMETER,
      background: { type: "string", description: "A PDF in your templates folder that is drawn under every page, e.g. your letterhead (its page 1 under the first page, its page 2, if any, under the others)" },
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
  const { maxFormFields } = client.settings;
  if (entries.length === 0 || entries.length > maxFormFields) throw invalidInput(`\`fields\` must name 1 to ${maxFormFields} form fields`);
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
  description: "Fills in a PDF form (a PDF with boxes you can type in) and saves the result as a new PDF in your documents folder. A protected form, as many official forms are, is filled in too, and the result is saved without the protection. `fields` says which value goes into which box; a value may use {{placeholders}} from `values`, including calculated totals such as {{totals.total | money}}. A PDF without such boxes (a scan, a picture, plain pages) cannot be filled in: use render_pdf",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "The PDF form, a .pdf file in your templates folder" },
      fields: { type: "object", description: "Form field names and their values, e.g. {\"InvoiceNo\": \"{{number}}\", \"Total\": \"{{totals.total | money}}\", \"Paid\": true}" },
      fields_file: { type: "string", description: "Instead of `fields`: a .json file with the field names and values, in your templates folder (reusable for every document from this form)" },
      ...VALUES_PARAMETERS,
      calculate: CALCULATE_PARAMETER,
      password: PDF_PASSWORD_PARAMETER,
      flatten: { type: "boolean", default: true, description: "Make the filled-in values a fixed part of the page, so that nobody can change them afterwards (default true)" },
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
    const { data, outputs } = await client.runTask("fill_pdf_form", { bytes: template.bytes, fieldValues, isFlattened: args.flatten, password: args.password, maxFields: client.settings.maxFormFields }, signal);
    const savedFile = await client.organiser.saveDocument({ plan: filingPlan, bytes: Buffer.from(outputs[0]), ifExists: args.if_exists });
    return { data: { ...describeResult(savedFile, { template, ...prepared }), ...data } };
  },
};

const fillDocxOperation = {
  name: "fill_docx",
  title: "Fill in a Word template",
  description: "Fills in a Word document that has {{placeholders}} (.docx, or a Word template .dotx) and saves the result as a new Word file in your documents folder. A table row between {{#items}} and {{/items}} repeats for every item, and totals are calculated for you. The result is a Word file, not a PDF",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "The Word file, a .docx or .dotx in your templates folder" },
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
