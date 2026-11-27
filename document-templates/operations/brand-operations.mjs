/**
 * The operations for a saved brand: save_brand keeps the look of your
 * documents and your own details, show_brand reads them back.
 */
import { BRAND_DETAIL_PARAMETERS, DEFAULT_BRAND_NAME, loadBrand, mergeBrandDetails, readBrandDetails, readBrandName, saveBrand } from "../lib/brand-profile.mjs";
import { invalidInput } from "../lib/errors.mjs";
import { readLogoFile } from "../lib/logo-file.mjs";
import { COLOR_NAMES, LOOK_PARAMETER } from "../lib/look-options.mjs";

const BRAND_NAME_PARAMETER = { type: "string", default: DEFAULT_BRAND_NAME, description: "Only when you keep more than one brand: its name, e.g. \"studio\". The brand named \"default\" is used for every document" };

const saveBrandOperation = {
  name: "save_brand",
  title: "Save the look of your documents",
  description: "Saves how your documents look and your own details, once, so that every later invoice uses them: a logo, an accent colour, the document's title, the language, other label texts, which optional parts show, your business name and address, your payment details and standard notes. Give only what should change; everything saved before stays. Nothing has to be edited in a template",
  parameters: {
    type: "object",
    properties: {
      look: LOOK_PARAMETER,
      ...BRAND_DETAIL_PARAMETERS,
      name: BRAND_NAME_PARAMETER,
      reset: { type: "boolean", default: false, description: "Start again: forget everything saved for this brand before and keep only what this call gives" },
    },
  },
  run: async ({ client, args }) => {
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
        used_for: name === DEFAULT_BRAND_NAME ? "Every document from now on, unless a document asks for another brand or for `brand: none`" : `Documents that ask for \`brand: ${name}\``,
      },
    };
  },
};

const showBrandOperation = {
  name: "show_brand",
  title: "Show the saved look of your documents",
  description: "Shows what is saved for your documents: the logo, accent colour, title, language, label texts, hidden parts, your own details, payment details and notes. Also lists the colour names an accent colour may use",
  parameters: { type: "object", properties: { name: BRAND_NAME_PARAMETER } },
  run: async ({ client, args }) => {
    const name = readBrandName(args.name);
    const brand = await loadBrand(await client.organiser.resolveOutputRoot(), name, client.numberingDependencies);
    return { data: { ...(brand ?? { name }), saved: brand !== null, color_names: Object.keys(COLOR_NAMES) } };
  },
};

export const brandOperations = [saveBrandOperation, showBrandOperation];
