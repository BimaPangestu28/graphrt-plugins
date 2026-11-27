/**
 * Read-only operations: which templates exist, what a template needs, and
 * the next document number. What a person reads is in the language the call
 * names (`language`), else the saved brand's, else English.
 */
import { FILTER_NAMES } from "../lib/expressions.mjs";
import { listTemplatePlaceholders } from "../lib/layout-template.mjs";
import { DEFAULT_NUMBER_PATTERN, issueNextNumber, readNumberDate } from "../lib/number-sequence.mjs";
import { FILLING_FORBIDDEN_MESSAGE, PDF_PASSWORD_PARAMETER, XFA_ONLY_MESSAGE } from "../lib/pdf-form.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { MESSAGE_LANGUAGE_PARAMETER, resolveMessageLanguage, translateMessage, withMessageLanguage } from "../lib/message-language.mjs";
import { toSafeSegment } from "../lib/output-organiser.mjs";
import { BUILT_IN_TEMPLATE_NAMES, loadBuiltInTemplate, readBuiltInTemplateText, resolveTemplate } from "../lib/template-library.mjs";

const TEMPLATE_COPY_FOLDER = "Templates";

// Texts of list_templates and describe_template that a person reads, in English and Indonesian.
const TEMPLATE_TEXTS = {
  en: {
    yourOwn: [
      { format: "Layout template (.json)", operation: "render_pdf", result: "PDF", note: "Same format as the built-in templates; describe_template with include_layout: true returns one to start from" },
      { format: "Fillable PDF form (.pdf with form fields)", operation: "fill_pdf_form", result: "PDF", note: "The form's fields are filled; the number of rows is fixed by the form" },
      { format: "Word template (.docx or .dotx with {{placeholders}})", operation: "fill_docx", result: "DOCX", note: "Rows repeat between {{#items}} and {{/items}}" },
    ],
    notSupported: ["PDF without form fields (scans, pictures): recreate it as a layout template, or use it as a `background`", "Excel (.xlsx)", "HTML", "Word to PDF conversion", "XFA forms"],
    invoiceCalculates: "invoice totals (items, discount, taxes, shipping, amount_paid)",
    builtInDescriptions: {},
  },
  id: {
    yourOwn: [
      { format: "Template tata letak (.json)", operation: "render_pdf", result: "PDF", note: "Formatnya sama dengan template bawaan; describe_template dengan include_layout: true memberikan satu untuk titik awal" },
      { format: "Formulir PDF isian (.pdf dengan kotak isian)", operation: "fill_pdf_form", result: "PDF", note: "Kotak isian formulir diisi; jumlah barisnya ditentukan oleh formulir" },
      { format: "Template Word (.docx atau .dotx dengan {{penanda}})", operation: "fill_docx", result: "DOCX", note: "Baris diulang di antara {{#items}} dan {{/items}}" },
    ],
    notSupported: ["PDF tanpa kotak isian (hasil pindai, gambar): buat ulang sebagai template tata letak, atau pakai sebagai latar belakang (`background`)", "Excel (.xlsx)", "HTML", "Konversi Word ke PDF", "Formulir XFA"],
    invoiceCalculates: "total invoice (item, diskon, pajak, ongkos kirim, jumlah yang sudah dibayar)",
    builtInDescriptions: {
      invoice: "Invoice A4: nama penjual dan nomor invoice, Dari / Ditagihkan kepada / Rincian, tabel item yang berlanjut ke halaman berikutnya, subtotal, diskon, pajak, total tagihan, kotak rincian pembayaran, catatan di kaki halaman terakhir dan nomor halaman. Kolom periode, jumlah dan harga satuan hanya muncul bila ada item yang memakainya.",
    },
  },
};

// The language a call's texts are written in: the call's `language`, else the saved brand's, else English.
function decideLanguage(client, args) {
  return () => resolveMessageLanguage(client, args, [args.language]);
}

const listTemplatesOperation = {
  name: "list_templates",
  title: "List templates",
  description: "Lists the ready-made templates and the kinds of template you can bring yourself (your own layout, a PDF form, a Word document), with the operation for each",
  parameters: { type: "object", properties: { language: MESSAGE_LANGUAGE_PARAMETER } },
  run: ({ client, args }) => withMessageLanguage(decideLanguage(client, args), async () => {
    const texts = TEMPLATE_TEXTS[await decideLanguage(client, args)()];
    const builtIn = await Promise.all(BUILT_IN_TEMPLATE_NAMES.map(async (name) => {
      const layout = await loadBuiltInTemplate(name);
      return { name, description: texts.builtInDescriptions[name] ?? layout.description, operation: "render_pdf", languages: Object.keys(layout.labels ?? {}) };
    }));
    return { data: { built_in: builtIn, your_own: texts.yourOwn, not_supported: texts.notSupported } };
  }),
};

function describePdfHint(data, language) {
  if (data.is_xfa_only) return translateMessage(XFA_ONLY_MESSAGE, language);
  if (!data.is_form) return translateMessage("This PDF has no form fields, so it cannot be filled in. Use render_pdf with the built-in invoice template, or a layout template with this PDF as its `background`", language);
  return data.filling_allowed ? null : translateMessage(FILLING_FORBIDDEN_MESSAGE, language);
}

async function describe(client, template, signal, { includeLayout, password, language }) {
  const texts = TEMPLATE_TEXTS[language];
  if (template.kind === "layout") {
    const { layout } = template;
    const description = (template.isBuiltIn ? texts.builtInDescriptions[template.name] : undefined) ?? layout.description ?? null;
    return {
      kind: "layout", operation: "render_pdf", name: template.name, built_in: template.isBuiltIn, description,
      calculates: layout.calculate === "invoice" ? texts.invoiceCalculates : null,
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
  const { data } = await client.runTask("inspect_pdf_form", { bytes: template.bytes, password, maxFields: client.settings.maxFormFields }, signal);
  return { kind: data.is_form ? "pdf_form" : "pdf", operation: data.is_form ? "fill_pdf_form" : null, name: template.name, path: template.path, ...data, hint: describePdfHint(data, language) };
}

const describeTemplateOperation = {
  name: "describe_template",
  title: "Describe a template",
  description: "Shows what a template needs before you fill it: for the invoice or your own layout, its fields with an example; for a Word document, its {{placeholders}}; for a PDF form, its boxes (or that it has none)",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", default: "invoice", description: "`invoice` (the ready-made template), or a .json, .docx, .dotx or .pdf file in your templates folder" },
      password: PDF_PASSWORD_PARAMETER,
      include_layout: { type: "boolean", default: false, description: "For the invoice or your own layout: also return the whole design. To get a copy you can change, use save_template_copy instead" },
      language: MESSAGE_LANGUAGE_PARAMETER,
    },
  },
  run: ({ client, args, signal }) => withMessageLanguage(decideLanguage(client, args), async () => {
    const template = await resolveTemplate(client, args.template, ["layout", "docx", "pdf"]);
    const language = await decideLanguage(client, args)();
    return { data: await describe(client, template, signal, { includeLayout: args.include_layout, password: args.password, language }) };
  }),
};

const nextNumberOperation = {
  name: "next_number",
  title: "Next document number",
  description: "Gives the next number of a series, such as INV-2026-0001, then INV-2026-0002, so that no two documents get the same number. The count starts again with each new year (or month, when the pattern has one). The last number is remembered in your documents folder",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", default: DEFAULT_NUMBER_PATTERN, description: "Number pattern with one {SEQ} (or {SEQ:4} for four digits) and optional {YYYY} {YY} {MM} {DD} {ROMAN} (month as a Roman numeral), e.g. \"{SEQ:3}/INV/{ROMAN}/{YYYY}\"" },
      date: { type: "string", description: "Date the number is for, as YYYY-MM-DD (default: today)" },
      start_at: { type: "integer", minimum: 1, maximum: 999999999, default: 1, description: "First number of a counter that has not been used yet, e.g. 38 to continue after INV-2026-0037" },
      preview: { type: "boolean", default: false, description: "Only show what the next number would be, without using it up" },
      language: MESSAGE_LANGUAGE_PARAMETER,
    },
  },
  run: ({ client, args }) => withMessageLanguage(decideLanguage(client, args), async () => {
    const outputRoot = await client.organiser.resolveOutputRoot();
    const request = { pattern: args.pattern, date: readNumberDate(args.date, client.now()), startAt: args.start_at, isPreview: args.preview };
    return { data: await issueNextNumber(outputRoot, request, { now: client.now, ...client.numberingDependencies }) };
  }),
};

const saveTemplateCopyOperation = {
  name: "save_template_copy",
  title: "Save a copy of a template to change",
  description: "Saves your own copy of a ready-made template in your documents folder (in the folder Templates), so that you can change its layout while the original stays as it is (for a logo, a colour, the title, the language or hidden columns no copy is needed: see save_brand). Nothing is ever replaced: when the name is taken, the copy gets a number. To use your copy, give its `path` as `template` when creating a PDF",
  parameters: {
    type: "object",
    properties: {
      template: { type: "string", default: "invoice", description: "The ready-made template to copy (invoice)" },
      name: { type: "string", description: "A name for your copy, without extension, e.g. \"Quotation\" (default: the template's own name)" },
      language: MESSAGE_LANGUAGE_PARAMETER,
    },
  },
  run: ({ client, args }) => withMessageLanguage(decideLanguage(client, args), async () => {
    const templateName = String(args.template).trim().toLowerCase();
    if (!BUILT_IN_TEMPLATE_NAMES.includes(templateName)) throw invalidInput(`\`template\` must be a ready-made template (${BUILT_IN_TEMPLATE_NAMES.join(", ")}), got ${JSON.stringify(args.template)}`);
    const fileStem = toSafeSegment(args.name ?? templateName);
    if (fileStem === "") throw invalidInput("`name` must have letters or digits, e.g. \"Quotation\"");
    const bytes = Buffer.from(await readBuiltInTemplateText(templateName), "utf8");
    // Saved like a document: only inside the output folder, never over a file that is there.
    const savedFile = await client.organiser.saveDocument({ plan: { folderSegments: [TEMPLATE_COPY_FOLDER], fileStem, extension: "json" }, bytes, ifExists: "number" });
    return {
      data: {
        ...savedFile,
        copied_from: templateName,
        how_to_use: describeCopyUse(savedFile.path, await decideLanguage(client, args)()),
      },
    };
  }),
};

function describeCopyUse(path, language) {
  if (language === "id") return `Untuk membuat PDF dengan salinan ini, berikan ${JSON.stringify(path)} sebagai \`template\` ke render_pdf. Buka file ini di editor teks untuk mengubah teks (\`labels\`), warna dan ukuran (\`styles\`) dan tata letaknya (\`content\`); describe_template dengan path yang sama menampilkan isiannya. Untuk logo, warna aksen, judul atau bahasa lain, atau kolom yang disembunyikan tidak perlu salinan: pakai \`look\` di render_pdf, atau save_brand untuk menyimpannya bagi setiap dokumen`;
  return `To create a PDF with this copy, pass ${JSON.stringify(path)} as \`template\` to render_pdf. Open the file in a text editor to change texts (\`labels\`), colours and sizes (\`styles\`) and the layout (\`content\`); describe_template with the same path shows its fields. For a logo, an accent colour, another title or language, or hidden columns no copy is needed: use \`look\` on render_pdf, or save_brand to keep them for every document`;
}

export const templateOperations = [listTemplatesOperation, describeTemplateOperation, saveTemplateCopyOperation, nextNumberOperation];
