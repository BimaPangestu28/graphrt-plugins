/**
 * The operations for a saved brand: save_brand keeps the look of your
 * documents and your own details, show_brand reads them back.
 */
import { BRAND_DETAIL_PARAMETERS, DEFAULT_BRAND_NAME, listFormPlaceholders, loadBrand, mergeBrandDetails, readBrandDetails, readBrandName, saveBrand } from "../lib/brand-profile.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { readLogoFile } from "../lib/logo-file.mjs";
import { COLOR_NAMES, LOOK_PARAMETER } from "../lib/look-options.mjs";
import { MESSAGE_LANGUAGE_PARAMETER, resolveMessageLanguage, withMessageLanguage } from "../lib/message-language.mjs";

// The language of what a person reads: the language being saved (save_brand), the call's `language` (show_brand),
// else the language this brand already has, else English.
function decideLanguage(client, args, givenLanguages) {
  return () => resolveMessageLanguage(client, { brand: readUsableBrandName(args.name) }, givenLanguages);
}

// A name that is not usable itself falls back to the default brand, whose language then decides.
function readUsableBrandName(rawName) {
  try {
    return readBrandName(rawName);
  } catch {
    return DEFAULT_BRAND_NAME;
  }
}

const BRAND_NAME_PARAMETER = { type: "string", default: DEFAULT_BRAND_NAME, description: "Only when you keep more than one brand: its name, e.g. \"studio\". The brand named \"default\" is used for every document" };

const saveBrandOperation = {
  name: "save_brand",
  title: "Save the look of your documents",
  description: "Saves how your documents look and your own details, once, so that every later document uses them: a logo, an accent colour, the document's title, the language, other label texts, which optional parts show, your business name and address, your payment details and standard notes. Give only what should change; everything saved before stays. Nothing has to be edited in a template",
  parameters: {
    type: "object",
    properties: {
      look: LOOK_PARAMETER,
      ...BRAND_DETAIL_PARAMETERS,
      name: BRAND_NAME_PARAMETER,
      reset: { type: "boolean", default: false, description: "Start again: forget everything saved for this brand before and keep only what this call gives" },
    },
  },
  run: ({ client, args }) => withMessageLanguage(decideLanguage(client, args, [args.look?.language]), async () => {
    const name = readBrandName(args.name);
    const details = readBrandDetails(args);
    if (Object.keys(details).length === 0) throw invalidInput("Give at least one thing to save: `look` (logo, accent_color, title, language, labels, show), `seller`, `payment_details` or `notes`");
    // The logo is read now, so that a wrong file is noticed when it is chosen and not on the next invoice.
    const logo = details.look?.logo ? await readLogoFile(client, details.look.logo) : null;
    if (logo) details.look.logo = logo.path;
    const outputRoot = await client.organiser.resolveOutputRoot();
    const earlier = args.reset ? null : await loadBrand(outputRoot, name, client.numberingDependencies);
    const saved = await saveBrand(outputRoot, { name, ...mergeBrandDetails(earlier, details) }, { now: client.now, ...client.numberingDependencies });
    return {
      data: {
        ...saved,
        ...(logo ? { logo_checked: { format: logo.format, width: logo.width, height: logo.height, size_bytes: logo.size_bytes } } : {}),
        used_for: describeUse(name, await decideLanguage(client, args, [args.look?.language])()),
        word_and_form_placeholders: listFormPlaceholders(saved),
      },
    };
  }),
};

function describeUse(name, language) {
  if (language === "id") {
    const scope = name === DEFAULT_BRAND_NAME ? "Setiap dokumen mulai sekarang, kecuali yang meminta brand lain atau `brand: none`" : `Dokumen yang meminta \`brand: ${name}\``;
    return `${scope}. PDF dari template (render_pdf) mendapat seluruh tampilan dan data Anda. Template Word (fill_docx) dan formulir PDF (fill_pdf_form) mendapat data dan bahasa Anda lewat penanda di word_and_form_placeholders, bila datanya tidak mengisinya; tata letaknya tetap, jadi logo dan warna tidak ditambahkan`;
  }
  const scope = name === DEFAULT_BRAND_NAME ? "Every document from now on, unless it asks for another brand or for `brand: none`" : `Documents that ask for \`brand: ${name}\``;
  return `${scope}. PDFs from a template (render_pdf) get the whole look and your details. Word templates (fill_docx) and PDF forms (fill_pdf_form) get your details and language through the placeholders in word_and_form_placeholders, where values leave them out; they keep their own layout, so the logo and colour are not added to them`;
}

const showBrandOperation = {
  name: "show_brand",
  title: "Show the saved look of your documents",
  description: "Shows what is saved for your documents: the logo, accent colour, title, language, label texts, hidden parts, your own details, payment details and notes. Also lists the colour names an accent colour may use",
  parameters: { type: "object", properties: { name: BRAND_NAME_PARAMETER, language: MESSAGE_LANGUAGE_PARAMETER } },
  run: ({ client, args }) => withMessageLanguage(decideLanguage(client, args, [args.language]), async () => {
    const name = readBrandName(args.name);
    const brand = await loadBrand(await client.organiser.resolveOutputRoot(), name, client.numberingDependencies);
    return { data: { ...(brand ?? { name }), saved: brand !== null, ...(brand ? { word_and_form_placeholders: listFormPlaceholders(brand) } : {}), color_names: Object.keys(COLOR_NAMES) } };
  }),
};

export const brandOperations = [saveBrandOperation, showBrandOperation];
