/**
 * The operations that produce a document: render_pdf (layout templates),
 * fill_pdf_form (fillable PDFs) and fill_docx (Word templates), and
 * check_values, which runs every check of render_pdf without saving. Each reads
 * its inputs from the allowed directories, does the heavy work in the
 * worker process and files the result under DOCUMENT_TEMPLATES_OUTPUT_DIR.
 */
import { DEFAULT_BRAND_NAME, applyBrandToFormValues, applyBrandToValues, resolveBrand } from "../lib/brand-profile.mjs";
import { invalidInput, operationFailed } from "../lib/errors.mjs";
import { Scope, interpolate } from "../lib/expressions.mjs";
import { CALCULATE_PARAMETER, VALUES_PARAMETERS, prepareValues, readValues, summariseTotals } from "../lib/document-values.mjs";
import { expandLayout, listMissingFields } from "../lib/layout-template.mjs";
import { checkLogoBytes } from "../lib/logo-file.mjs";
import { issueNextNumber, readNumberDate, resolveNumberPattern, useNumberWhenSaved } from "../lib/number-sequence.mjs";
import { LOOK_PARAMETER, applyLookToValues, applyShowToValues, mergeLooks, readLook } from "../lib/look-options.mjs";
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

// logoPath is the logo a look or a brand chose: it gets the stricter checks of a logo (size in bytes and pixels).
async function readImages(client, imagePaths, logoPath) {
  const images = [];
  for (const imagePath of imagePaths) {
    const file = await client.fileAccess.readInputFile(imagePath, { parameterName: "image" });
    if (imagePath === logoPath) checkLogoBytes(file.bytes, `The logo ${JSON.stringify(imagePath)}`);
    else assertRasterFormat(file.bytes, ["png", "jpeg"], `The image ${JSON.stringify(imagePath)}`);
    images.push(file.bytes);
  }
  return images;
}

/**
 * Joins the saved brand and the look of this call into the values of a document.
 * The look of the call wins over the values, the values win over the brand.
 *
 * @returns `{values, look, brandName, logoPath}`: look is the joined look (accent colour, hidden parts); logoPath is set when the logo came from a look (object)
 */
async function applyBrandAndLook(client, args, rawValues) {
  const callLook = readLook(args.look);
  const brand = await loadCallBrand(client, args);
  const values = applyLookToValues(applyBrandToValues(rawValues, brand), callLook, { isDefault: false });
  const lookLogo = callLook.logo ?? brand?.look?.logo;
  return { values, look: mergeLooks(brand?.look, callLook), brandName: brand?.name ?? null, logoPath: lookLogo !== undefined && values.seller?.logo === lookLogo ? lookLogo : null };
}

// The brand a call asks for (`brand`), the default brand, or null for `brand: none` and when none was saved.
async function loadCallBrand(client, args) {
  // Without a documents folder nothing can be saved anyway; that message comes from the filing step.
  const outputRoot = await client.organiser.resolveOutputRoot().catch(() => null);
  return outputRoot ? resolveBrand(outputRoot, args.brand, client.numberingDependencies) : null;
}

// Word templates and PDF forms take the brand's details and language, never its look (see applyBrandToFormValues).
// With a saved brand a Word template may need no `values` at all, e.g. a letterhead with only {{business.name}}.
async function readFormValues(client, args) {
  const brand = await loadCallBrand(client, args);
  const values = await readValues(client, args, { isRequired: false });
  return { rawValues: applyBrandToFormValues(values, brand), brandName: brand?.name ?? null };
}

const FORM_BRAND_PARAMETER = {
  type: "string",
  default: DEFAULT_BRAND_NAME,
  description: "Your details saved with save_brand fill placeholders such as {{business.name}}, {{business.address | join}}, {{payment.bank}} and {{notes}} when `values` leaves them out; what `values` gives always wins. The saved language sets how dates and amounts are written. The saved logo and colour are not used: the file keeps its own layout. Give a brand's name when you keep more than one, or `none` to use only `values`",
};

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

const NUMBER_PATTERN_PARAMETERS = {
  number_pattern: { type: "string", description: "Give the document the next number of this series, e.g. \"INV-{YYYY}-{SEQ:4}\" (the same patterns as next_number), instead of a `number` in `values`. The number is only used up once the PDF is saved: a document that cannot be made uses no number, so the series has no gaps. The year and month come from the document's date" },
  number_start_at: { type: "integer", minimum: 1, maximum: 999999999, default: 1, description: "With `number_pattern`: the first number of a series that has not been used yet, e.g. 38 to continue after INV-2026-0037" },
};

const LAYOUT_DOCUMENT_PARAMETERS = {
  template: { type: "string", default: "invoice", description: "`invoice` (the ready-made template), or your own template: a .json file in your templates folder, or the `path` that save_template_copy returned" },
  ...VALUES_PARAMETERS,
  calculate: CALCULATE_PARAMETER,
  look: LOOK_PARAMETER,
  brand: { type: "string", default: DEFAULT_BRAND_NAME, description: "Only when you keep more than one saved brand: its name, or `none` for a document without your saved look and details. The look saved with save_brand is used by itself" },
  background: { type: "string", description: "A PDF in your templates folder that is drawn under every page, e.g. your letterhead (its page 1 under the first page, its page 2, if any, under the others)" },
  ...NUMBER_PATTERN_PARAMETERS,
  ...FILING_PARAMETERS,
};

// How often render_pdf draws again when other calls keep taking the number it drew with.
const MAX_NUMBER_ATTEMPTS = 5;

// The template, the values joined with the brand and look, and the number series when one was asked for.
async function readLayoutRequest(client, args, source) {
  assertIfExistsAllowed(args.if_exists, source);
  const template = await resolveTemplate(client, args.template, ["layout"]);
  const branded = await applyBrandAndLook(client, args, await readValues(client, args));
  return { template, branded, numbering: await readNumbering(client, args, branded.values) };
}

async function readNumbering(client, args, values) {
  if (args.number_pattern === undefined) return null;
  if (values.number !== undefined && values.number !== null && values.number !== "") throw invalidInput("Give the document's `number` in `values` or a `number_pattern`, not both");
  const outputRoot = await client.organiser.resolveOutputRoot();
  // Checked now, so that a bad pattern is reported before anything is drawn.
  const date = readNumberDate(values.date, client.now());
  resolveNumberPattern(args.number_pattern, date);
  return { outputRoot, request: { pattern: args.number_pattern, date, startAt: args.number_start_at ?? 1 }, dependencies: { now: client.now, ...client.numberingDependencies } };
}

// What the next number of the series is now, without using it up.
function previewNumber(numbering) {
  return issueNextNumber(numbering.outputRoot, { ...numbering.request, isPreview: true }, numbering.dependencies);
}

/**
 * Everything render_pdf does before saving: checks and calculates the values, draws the PDF in the worker and
 * checks the file name. Nothing is written.
 *
 * @returns `{bytes, filingPlan, prepared, pageCount}` (object)
 */
async function drawLayoutDocument(client, args, signal, { template, branded }, rawValues) {
  // Checked on the values as given, so the message names what to add before any amount is calculated.
  const missingFields = listMissingFields(template.layout, rawValues);
  if (missingFields.length > 0) throw invalidInput(`The ${template.name} template needs these values: ${missingFields.join(", ")}. describe_template shows every field with an example`);
  const prepared = prepareValues(rawValues, { calculate: args.calculate, templateCalculates: template.layout.calculate === "invoice", now: client.now() });
  const shownValues = applyShowToValues(prepared.values, branded.look.show);
  const plan = expandLayout(template.layout, shownValues, prepared.settings, { today: prepared.today, colors: branded.look.accent_color ? { accent: branded.look.accent_color } : {} });
  const filingPlan = await planFiling(client, args, { values: prepared.values, templateName: template.name, extension: "pdf" });
  const images = await readImages(client, plan.imagePaths, branded.logoPath);
  const backgroundPath = args.background ?? plan.page.background_pdf;
  const backgroundPdf = backgroundPath ? await readPdfInput(client, backgroundPath, "background") : null;
  const { data, outputs } = await client.runTask("render_layout", { plan, images, backgroundPdf, extraFontPaths: client.settings.extraFontPaths, maxPages: client.settings.maxPages }, signal);
  return { bytes: Buffer.from(outputs[0]), filingPlan, prepared, pageCount: data.page_count };
}

function describeLayoutResult(savedFile, request, drawn) {
  return { ...describeResult(savedFile, { template: request.template, ...drawn.prepared }), page_count: drawn.pageCount, ...(request.branded.brandName ? { brand: request.branded.brandName } : {}) };
}

const renderPdfOperation = {
  name: "render_pdf",
  title: "Create a PDF from a template",
  description: "Creates a PDF document, such as an invoice, from a template and your values: the ready-made `invoice`, or your own template. Totals are calculated for you and a long list of items continues on the next page. `look` gives it your logo, colour, title and language and hides parts you do not use; what save_brand saved is used by itself. With `number_pattern` it takes the next number of a series itself, and only once the PDF is saved, so a failed document leaves no gap. The PDF is saved in your documents folder, sorted by year and month (2026/11/INV-2026-0001.pdf), and a document that is already there is never replaced. The result says where the file is",
  parameters: { type: "object", properties: LAYOUT_DOCUMENT_PARAMETERS },
  run: async ({ client, args, signal, source }) => {
    const request = await readLayoutRequest(client, args, source);
    const save = (drawn) => client.organiser.saveDocument({ plan: drawn.filingPlan, bytes: drawn.bytes, ifExists: args.if_exists });
    if (!request.numbering) {
      const drawn = await drawLayoutDocument(client, args, signal, request, request.branded.values);
      return { data: describeLayoutResult(await save(drawn), request, drawn) };
    }
    const { numbering } = request;
    for (let attempt = 1; attempt <= MAX_NUMBER_ATTEMPTS; attempt += 1) {
      const next = await previewNumber(numbering);
      const drawn = await drawLayoutDocument(client, args, signal, request, { ...request.branded.values, number: next.number });
      const used = await useNumberWhenSaved(numbering.outputRoot, { ...numbering.request, sequence: next.sequence }, () => save(drawn), numbering.dependencies);
      if (!used.isTaken) return { data: describeLayoutResult(used.saved, request, drawn) };
    }
    throw operationFailed(`Other documents kept taking the next number of ${JSON.stringify(args.number_pattern)}; nothing was saved and no number was used. Try again`);
  },
};

// Problems the person can fix in the values, the template or the files they named; anything else is reported as a failure.
const FIXABLE_PROBLEM_KINDS = ["invalid_input", "not_found", "permission_denied"];

/**
 * Words a person reads more easily than a path into the values: `items[0].unit_price` becomes "the unit price of
 * item 1", `client.name` becomes "client name" and `currency` "currency".
 *
 * @param message - A PluginError message (string)
 * @returns The message with value paths written out, starting with a capital letter (string)
 */
export function toPlainProblem(message) {
  const toWords = (path) => path.replaceAll(/[._]/g, " ");
  const plain = String(message)
    .replace(/`items\[(\d+)\]\.([A-Za-z_]+)`/g, (_match, index, field) => `the ${toWords(field)} of item ${Number(index) + 1}`)
    .replace(/`([a-z][a-z_]*(?:\.[a-z][a-z_]*)*)`/g, (_match, path) => toWords(path));
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

const checkValuesOperation = {
  name: "check_values",
  title: "Check a document before creating it",
  description: "Checks everything render_pdf would check, without saving anything or using up a number: the values, amounts, currency and dates, the fields the template needs, the logo and the file name. The PDF is drawn to be sure, then thrown away. The result says `ok` and, when something is wrong, the `problem` in plain words; when it is fine, the totals, the number the document would get with `number_pattern` and where it would be saved. Use it before asking for an approval and taking a number",
  parameters: { type: "object", properties: LAYOUT_DOCUMENT_PARAMETERS },
  run: async ({ client, args, signal, source }) => {
    try {
      const request = await readLayoutRequest(client, args, source);
      const values = request.numbering ? { ...request.branded.values, number: (await previewNumber(request.numbering)).number } : request.branded.values;
      const drawn = await drawLayoutDocument(client, args, signal, request, values);
      const relativePath = [...drawn.filingPlan.folderSegments, `${drawn.filingPlan.fileStem}.${drawn.filingPlan.extension}`].join("/");
      return {
        data: {
          ok: true,
          problem: null,
          template: request.template.name,
          number: drawn.prepared.values.number ?? null,
          ...(drawn.prepared.isCalculated ? { totals: summariseTotals(drawn.prepared.values, drawn.prepared.settings) } : {}),
          page_count: drawn.pageCount,
          relative_path: relativePath,
          ...(request.branded.brandName ? { brand: request.branded.brandName } : {}),
        },
      };
    } catch (checkError) {
      if (!FIXABLE_PROBLEM_KINDS.includes(checkError?.kind)) throw checkError;
      return { data: { ok: false, problem: toPlainProblem(checkError.message), template: null, number: null, page_count: null, relative_path: null } };
    }
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
  description: "Fills in a PDF form (a PDF with boxes you can type in) and saves the result as a new PDF in your documents folder. A protected form, as many official forms are, is filled in too, and the result is saved without the protection. `fields` says which value goes into which box; a value may use {{placeholders}} from `values`, including calculated totals such as {{totals.total | money}}, and your details saved with save_brand ({{business.name}}, {{payment.bank}}). A PDF without such boxes (a scan, a picture, plain pages) cannot be filled in: use render_pdf",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "The PDF form, a .pdf file in your templates folder" },
      fields: { type: "object", description: "Form field names and their values, e.g. {\"InvoiceNo\": \"{{number}}\", \"Total\": \"{{totals.total | money}}\", \"Paid\": true}" },
      fields_file: { type: "string", description: "Instead of `fields`: a .json file with the field names and values, in your templates folder (reusable for every document from this form)" },
      ...VALUES_PARAMETERS,
      calculate: CALCULATE_PARAMETER,
      brand: FORM_BRAND_PARAMETER,
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
    const { rawValues, brandName } = await readFormValues(client, args);
    const prepared = prepareValues(rawValues, { calculate: args.calculate, templateCalculates: null, now: client.now() });
    const fieldValues = fillFieldValues(fieldEntries, prepared);
    const filingPlan = await planFiling(client, args, { values: prepared.values, templateName: template.name, extension: "pdf" });
    const { data, outputs } = await client.runTask("fill_pdf_form", { bytes: template.bytes, fieldValues, isFlattened: args.flatten, password: args.password, maxFields: client.settings.maxFormFields }, signal);
    const savedFile = await client.organiser.saveDocument({ plan: filingPlan, bytes: Buffer.from(outputs[0]), ifExists: args.if_exists });
    return { data: { ...describeResult(savedFile, { template, ...prepared }), ...data, ...(brandName ? { brand: brandName } : {}) } };
  },
};

const fillDocxOperation = {
  name: "fill_docx",
  title: "Fill in a Word template",
  description: "Fills in a Word document that has {{placeholders}} (.docx, or a Word template .dotx) and saves the result as a new Word file in your documents folder. A table row between {{#items}} and {{/items}} repeats for every item, totals are calculated for you, and your details saved with save_brand fill {{business.name}}, {{business.address | join}}, {{payment.bank}} and the like. The result is a Word file, not a PDF",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", description: "The Word file, a .docx or .dotx in your templates folder" },
      ...VALUES_PARAMETERS,
      calculate: CALCULATE_PARAMETER,
      brand: FORM_BRAND_PARAMETER,
      ...FILING_PARAMETERS,
    },
    required: ["template"],
  },
  run: async ({ client, args, signal, source }) => {
    assertIfExistsAllowed(args.if_exists, source);
    const template = await resolveTemplate(client, args.template, ["docx"]);
    const { rawValues, brandName } = await readFormValues(client, args);
    const prepared = prepareValues(rawValues, { calculate: args.calculate, templateCalculates: null, now: client.now() });
    const filingPlan = await planFiling(client, args, { values: prepared.values, templateName: template.name, extension: "docx" });
    const { outputs } = await client.runTask("fill_docx", { bytes: template.bytes, values: { ...prepared.values, today: prepared.today }, settings: prepared.settings }, signal);
    const savedFile = await client.organiser.saveDocument({ plan: filingPlan, bytes: Buffer.from(outputs[0]), ifExists: args.if_exists });
    return { data: { ...describeResult(savedFile, { template, ...prepared }), ...(brandName ? { brand: brandName } : {}) } };
  },
};

export const documentOperations = [checkValuesOperation, renderPdfOperation, fillPdfFormOperation, fillDocxOperation];
