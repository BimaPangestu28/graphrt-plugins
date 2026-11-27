/**
 * Read-only operations: which templates exist, what a template needs, and
 * the next document number.
 */
import { FILTER_NAMES } from "../lib/expressions.mjs";
import { listTemplatePlaceholders } from "../lib/layout-template.mjs";
import { DEFAULT_NUMBER_PATTERN, issueNextNumber, readNumberDate } from "../lib/number-sequence.mjs";
import { BUILT_IN_TEMPLATE_NAMES, loadBuiltInTemplate, resolveTemplate } from "../lib/template-library.mjs";

const listTemplatesOperation = {
  name: "list_templates",
  title: "List templates",
  description: "Lists the built-in templates and the template formats this plugin can fill, with the operation for each",
  parameters: { type: "object", properties: {} },
  run: async () => {
    const builtIn = await Promise.all(BUILT_IN_TEMPLATE_NAMES.map(async (name) => {
      const layout = await loadBuiltInTemplate(name);
      return { name, description: layout.description, operation: "render_pdf", languages: Object.keys(layout.labels ?? {}) };
    }));
    return {
      data: {
        built_in: builtIn,
        your_own: [
          { format: "Layout template (.json)", operation: "render_pdf", result: "PDF", note: "Same format as the built-in templates; describe_template with include_layout: true returns one to start from" },
          { format: "Fillable PDF form (.pdf with form fields)", operation: "fill_pdf_form", result: "PDF", note: "The form's fields are filled; the number of rows is fixed by the form" },
          { format: "Word template (.docx with {{placeholders}})", operation: "fill_docx", result: "DOCX", note: "Rows repeat between {{#items}} and {{/items}}" },
        ],
        not_supported: ["PDF without form fields (scans, pictures): recreate it as a layout template, or use it as a `background`", "Excel (.xlsx)", "HTML", "Word to PDF conversion", "XFA forms"],
      },
    };
  },
};

async function describe(client, template, signal, includeLayout) {
  if (template.kind === "layout") {
    const { layout } = template;
    return {
      kind: "layout", operation: "render_pdf", name: template.name, built_in: template.isBuiltIn, description: layout.description ?? null,
      calculates: layout.calculate === "invoice" ? "invoice totals (items, discount, taxes, shipping, amount_paid)" : null,
      languages: Object.keys(layout.labels ?? {}),
      fields: Array.isArray(layout.fields) ? layout.fields : [],
      placeholders: listTemplatePlaceholders(layout),
      filters: FILTER_NAMES,
      sample_values: layout.sample_values ?? null,
      ...(includeLayout ? { layout } : {}),
    };
  }
  if (template.kind === "docx") {
    const { data } = await client.runTask("inspect_docx", { bytes: template.bytes }, signal);
    return { kind: "docx", operation: "fill_docx", name: template.name, path: template.path, ...data, filters: FILTER_NAMES };
  }
  const { data } = await client.runTask("inspect_pdf_form", { bytes: template.bytes }, signal);
  const hint = data.is_form ? null : "This PDF has no form fields, so it cannot be filled in. Use render_pdf with the built-in invoice template, or a layout template with this PDF as its `background`";
  return { kind: data.is_form ? "pdf_form" : "pdf", operation: data.is_form ? "fill_pdf_form" : null, name: template.name, path: template.path, ...data, hint };
}

const describeTemplateOperation = {
  name: "describe_template",
  title: "Describe a template",
  description: "Shows what a template needs: for a layout template its fields, placeholders and sample values; for a Word template its {{placeholders}}; for a PDF its form fields (or that it has none)",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", default: "invoice", description: "Built-in template name (invoice), or a .json, .docx or .pdf file inside DOCUMENT_TEMPLATES_INPUT_DIRS" },
      include_layout: { type: "boolean", default: false, description: "For a layout template: also return its full layout, to save as a .json file and adapt" },
    },
  },
  run: async ({ client, args, signal }) => {
    const template = await resolveTemplate(client, args.template, ["layout", "docx", "pdf"]);
    return { data: await describe(client, template, signal, args.include_layout) };
  },
};

const nextNumberOperation = {
  name: "next_number",
  title: "Next document number",
  description: "Issues the next running number for a pattern such as INV-{YYYY}-{SEQ:4} (INV-2026-0001, INV-2026-0002, ...). The count restarts when the pattern's date part changes. Counters are kept in DOCUMENT_TEMPLATES_OUTPUT_DIR/.document-templates/numbering.json",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", default: DEFAULT_NUMBER_PATTERN, description: "Number pattern with one {SEQ} (or {SEQ:4} for four digits) and optional {YYYY} {YY} {MM} {DD} {ROMAN} (month as a Roman numeral), e.g. \"{SEQ:3}/INV/{ROMAN}/{YYYY}\"" },
      date: { type: "string", description: "Date the number is for, as YYYY-MM-DD (default: today)" },
      start_at: { type: "integer", minimum: 1, maximum: 999999999, default: 1, description: "First number of a counter that has not been used yet, e.g. 38 to continue after INV-2026-0037" },
      preview: { type: "boolean", default: false, description: "Only show the next number without reserving it" },
    },
  },
  run: async ({ client, args }) => {
    const outputRoot = await client.organiser.resolveOutputRoot();
    const request = { pattern: args.pattern, date: readNumberDate(args.date, client.now()), startAt: args.start_at, isPreview: args.preview };
    return { data: await issueNextNumber(outputRoot, request, { now: client.now, ...client.numberingDependencies }) };
  },
};

export const templateOperations = [listTemplatesOperation, describeTemplateOperation, nextNumberOperation];
