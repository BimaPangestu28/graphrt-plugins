/**
 * Saved brands: the look of your documents (logo, colour, title, language,
 * labels, hidden parts) and your own details (business name, address,
 * payment details, standard notes), kept so that nobody has to repeat them
 * for every document.
 *
 * A brand is a small JSON file in `.document-templates/brands/` inside the
 * documents folder, next to the numbering file. It is written by this
 * module only and replaced with rename(), so a crash never leaves half a
 * file. The brand named "default" is used for every document unless a call
 * names another one or "none".
 */
import { promises as defaultFileSystem } from "node:fs";
import { join, sep } from "node:path";
import { invalidInput, notFound, operationFailed } from "./errors.mjs";
import { applyLookToValues, mergeLooks, readLook } from "./look-options.mjs";

export const DEFAULT_BRAND_NAME = "default";
export const NO_BRAND_NAME = "none";
const STATE_DIRECTORY_NAME = ".document-templates";
const BRANDS_DIRECTORY_NAME = "brands";
const BRAND_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_BRANDS = 50;
const MAX_BRAND_BYTES = 64 * 1024;
const MAX_LINE_LENGTH = 200;
const MAX_LINES = 12;
const MAX_PAYMENT_DETAILS = 12;
const SELLER_TEXT_FIELDS = ["name", "tagline"];
const SELLER_LINE_FIELDS = ["address", "details"];

/** Schemas of the parameters that describe a brand's own details. */
export const BRAND_DETAIL_PARAMETERS = {
  seller: { type: "object", description: "Your own details, printed on every document: {\"name\": \"CV Kenanga Digital\", \"tagline\": \"Software studio\", \"address\": [\"Jalan Kenanga 12\", \"Bandung 40115\"], \"details\": [\"NPWP 00.000.000.0-000.000\", \"halo@kenanga.example\"]}" },
  payment_details: { type: "array", items: { type: "object" }, maxItems: MAX_PAYMENT_DETAILS, description: "How you are paid, as label and value pairs: [{\"label\": \"Bank\", \"value\": \"Example Bank\"}, {\"label\": \"Account number\", \"value\": \"000 111 2222\"}]" },
  notes: { type: "array", items: { type: "string" }, maxItems: MAX_LINES, description: "Notes printed at the foot of every document, one paragraph each" },
};

/**
 * Reads a brand name.
 *
 * @param rawName - e.g. "default" or "Kenanga Studio" (string, optional)
 * @returns Lowercase name of letters, digits, - and _ (string)
 * @throws PluginError kind `invalid_input` - When nothing usable is left, or the name is "none"
 *
 * @example
 * readBrandName("Kenanga Studio"); // "kenanga-studio"
 */
export function readBrandName(rawName) {
  if (rawName === undefined || rawName === null || rawName === "") return DEFAULT_BRAND_NAME;
  const name = String(rawName).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!BRAND_NAME_PATTERN.test(name) || name === NO_BRAND_NAME) throw invalidInput(`\`name\` must be a short name of letters and digits such as "default" or "studio", got ${JSON.stringify(rawName)}`);
  return name;
}

/**
 * Checks the details of a brand.
 *
 * @param rawDetails - `{look, seller, payment_details, notes}` as given; each optional (object)
 * @returns Only what was given, checked: `{look?, seller?, payment_details?, notes?}` (object)
 * @throws PluginError kind `invalid_input` - When a part has an invalid shape or is too long
 */
export function readBrandDetails(rawDetails) {
  const details = {};
  const look = readLook(rawDetails.look);
  if (Object.keys(look).length > 0) details.look = look;
  if (isPresent(rawDetails.seller)) details.seller = readSeller(rawDetails.seller);
  if (isPresent(rawDetails.payment_details)) details.payment_details = readPaymentDetails(rawDetails.payment_details);
  if (isPresent(rawDetails.notes)) details.notes = readLines(rawDetails.notes, "notes", 1000);
  return details;
}

/**
 * Joins new details into a saved brand: what is given replaces the same part, everything else stays.
 *
 * @param saved - The brand as saved, or null (object | null)
 * @param details - From readBrandDetails (object)
 * @returns `{look, seller, payment_details, notes}` without empty parts (object)
 */
export function mergeBrandDetails(saved, details) {
  const merged = {
    look: mergeLooks(saved?.look, details.look),
    seller: { ...saved?.seller, ...details.seller },
    payment_details: details.payment_details ?? saved?.payment_details,
    notes: details.notes ?? saved?.notes,
  };
  return Object.fromEntries(Object.entries(merged).filter(([, part]) => part !== undefined && (Array.isArray(part) ? part.length > 0 : Object.keys(part).length > 0)));
}

/**
 * Fills a document's values from a brand. The values a call gives always win; the brand fills what they leave open.
 *
 * @param values - Values as given (object)
 * @param brand - From loadBrand, or null (object | null)
 * @returns A copy of the values (object)
 */
export function applyBrandToValues(values, brand) {
  if (!brand) return values;
  let result = { ...values };
  if (brand.seller) {
    const givenSeller = isPlainObject(result.seller) ? result.seller : {};
    result.seller = { ...brand.seller, ...Object.fromEntries(Object.entries(givenSeller).filter(([, value]) => isPresent(value))) };
  }
  if (brand.payment_details && !isPresent(result.payment?.details)) result.payment = { ...(isPlainObject(result.payment) ? result.payment : {}), details: brand.payment_details };
  if (brand.notes && !isPresent(result.notes)) result.notes = brand.notes;
  if (brand.look) result = applyLookToValues(result, brand.look, { isDefault: true });
  return result;
}

/**
 * Reads a saved brand.
 *
 * @param outputRoot - Real path of the documents folder (string)
 * @param name - From readBrandName (string)
 * @param dependencies - `{fileSystem}` override for tests (object, optional)
 * @returns `{name, look?, seller?, payment_details?, notes?, updated_at}`, or null when there is none (object | null)
 * @throws PluginError kinds `invalid_input` (the file is damaged), `plugin_error` (I/O failure)
 */
export async function loadBrand(outputRoot, name, dependencies = {}) {
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const brandPath = join(outputRoot, STATE_DIRECTORY_NAME, BRANDS_DIRECTORY_NAME, `${name}.json`);
  const stats = await fileSystem.lstat(brandPath).catch((statError) => {
    if (statError?.code === "ENOENT" || statError?.code === "ENOTDIR") return null;
    throw operationFailed(`Could not read the brand ${JSON.stringify(name)}: ${statError.code ?? statError.message}`);
  });
  if (stats === null) return null;
  const damaged = (reason) => invalidInput(`The saved brand ${JSON.stringify(name)} is damaged (${reason}). Save it again with save_brand and \`reset: true\``);
  if (!stats.isFile() || stats.size > MAX_BRAND_BYTES) throw damaged("not a small plain file");
  try {
    const document = JSON.parse(await fileSystem.readFile(brandPath, "utf8"));
    if (!isPlainObject(document) || document.version !== 1) throw new Error("unexpected content");
    // Checked again on every read: the file could have been edited by hand.
    return { name, ...readBrandDetails(document), updated_at: typeof document.updated_at === "string" ? document.updated_at : null };
  } catch (readError) {
    throw damaged(readError.message);
  }
}

/**
 * Saves a brand, replacing the earlier version of the same name.
 *
 * @param outputRoot - Real path of the documents folder (string)
 * @param brand - `{name, look?, seller?, payment_details?, notes?}`, already checked (object)
 * @param dependencies - `{fileSystem, now}` overrides for tests (object, optional)
 * @returns The brand as saved, with `updated_at` (object)
 * @throws PluginError kinds `invalid_input` (too many brands, the folder leads elsewhere), `plugin_error` (I/O failure)
 */
export async function saveBrand(outputRoot, brand, dependencies = {}) {
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const now = dependencies.now ?? (() => new Date());
  const directory = await ensureBrandsDirectory(fileSystem, outputRoot);
  const fileName = `${brand.name}.json`;
  const existingNames = (await fileSystem.readdir(directory)).filter((entry) => entry.endsWith(".json"));
  if (!existingNames.includes(fileName) && existingNames.length >= MAX_BRANDS) throw invalidInput(`There are already ${MAX_BRANDS} saved brands; save over one of them`);
  const saved = { ...brand, updated_at: now().toISOString() };
  const { name, ...content } = saved;
  const brandPath = join(directory, fileName);
  const temporaryPath = `${brandPath}.${process.pid}.tmp`;
  try {
    await fileSystem.writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...content }, null, 2)}\n`, { mode: 0o600 });
    await fileSystem.rename(temporaryPath, brandPath);
  } catch (writeError) {
    await fileSystem.rm(temporaryPath, { force: true }).catch(() => {});
    throw operationFailed(`Could not save the brand: ${writeError.code ?? writeError.message}`);
  }
  return saved;
}

/**
 * Finds the brand a document uses.
 *
 * @param outputRoot - Real path of the documents folder (string)
 * @param rawName - The `brand` argument: a name, "none", or nothing for the default brand (string, optional)
 * @param dependencies - `{fileSystem}` override for tests (object, optional)
 * @returns The brand, or null for "none" and for a default brand that was never saved (object | null)
 * @throws PluginError kind `not_found` - When a brand is named that was never saved
 */
export async function resolveBrand(outputRoot, rawName, dependencies = {}) {
  if (String(rawName ?? "").trim().toLowerCase() === NO_BRAND_NAME) return null;
  const name = readBrandName(rawName);
  const brand = await loadBrand(outputRoot, name, dependencies);
  if (!brand && name !== DEFAULT_BRAND_NAME) throw notFound(`There is no saved brand named ${JSON.stringify(name)}. save_brand creates one; leave \`brand\` out to use the default brand`);
  return brand;
}

// Each level is created on its own and must really be a folder inside the documents folder (no link leads out).
async function ensureBrandsDirectory(fileSystem, outputRoot) {
  let directory = outputRoot;
  for (const segment of [STATE_DIRECTORY_NAME, BRANDS_DIRECTORY_NAME]) {
    const nextPath = join(directory, segment);
    await fileSystem.mkdir(nextPath, { mode: 0o700 }).catch((mkdirError) => {
      if (mkdirError?.code !== "EEXIST") throw operationFailed(`Could not create the folder for brands: ${mkdirError.code ?? mkdirError.message}`);
    });
    const stats = await fileSystem.lstat(nextPath);
    const realNext = await fileSystem.realpath(nextPath);
    const isInsideRoot = realNext.startsWith(outputRoot.endsWith(sep) ? outputRoot : `${outputRoot}${sep}`);
    if (!stats.isDirectory() || !isInsideRoot) throw invalidInput(`${STATE_DIRECTORY_NAME}/${BRANDS_DIRECTORY_NAME} in your documents folder is not a plain folder; brands cannot be saved there`);
    directory = realNext;
  }
  return directory;
}

function readSeller(rawSeller) {
  if (!isPlainObject(rawSeller)) throw invalidInput("`seller` must be an object such as {\"name\": \"CV Kenanga Digital\", \"address\": [\"Jalan Kenanga 12\", \"Bandung\"]}");
  const allowedFields = [...SELLER_TEXT_FIELDS, ...SELLER_LINE_FIELDS];
  const unknownFields = Object.keys(rawSeller).filter((field) => !allowedFields.includes(field));
  // The logo belongs to the look, so that it is checked as a picture.
  if (unknownFields.length > 0) throw invalidInput(`\`seller\` does not know ${unknownFields.map((field) => JSON.stringify(field)).join(", ")}; it takes ${allowedFields.join(", ")} (a logo goes in \`look\`)`);
  const seller = {};
  for (const field of SELLER_TEXT_FIELDS) if (isPresent(rawSeller[field])) seller[field] = readLine(rawSeller[field], `seller.${field}`, MAX_LINE_LENGTH);
  for (const field of SELLER_LINE_FIELDS) if (isPresent(rawSeller[field])) seller[field] = readLines(rawSeller[field], `seller.${field}`, MAX_LINE_LENGTH);
  return seller;
}

function readPaymentDetails(rawDetails) {
  if (!Array.isArray(rawDetails) || rawDetails.length > MAX_PAYMENT_DETAILS) throw invalidInput(`\`payment_details\` must be a list of at most ${MAX_PAYMENT_DETAILS} pairs such as [{"label": "Bank", "value": "Example Bank"}]`);
  return rawDetails.map((pair, index) => {
    if (!isPlainObject(pair) || !isPresent(pair.label) || !isPresent(pair.value)) throw invalidInput(`\`payment_details[${index}]\` needs a \`label\` and a \`value\`, e.g. {"label": "Bank", "value": "Example Bank"}`);
    return { label: readLine(pair.label, `payment_details[${index}].label`, 60), value: readLine(pair.value, `payment_details[${index}].value`, MAX_LINE_LENGTH) };
  });
}

// One text is a list of one line; a text with line breaks is one line each.
function readLines(rawLines, label, maxLength) {
  const lines = (Array.isArray(rawLines) ? rawLines : String(rawLines).split(/\r?\n/)).filter(isPresent);
  if (lines.length > MAX_LINES) throw invalidInput(`\`${label}\` has ${lines.length} lines, over the limit of ${MAX_LINES}`);
  return lines.map((line, index) => readLine(line, `${label}[${index}]`, maxLength));
}

function readLine(rawLine, label, maxLength) {
  const line = typeof rawLine === "string" || typeof rawLine === "number" ? String(rawLine).replace(/\s+/g, " ").trim() : null;
  if (line === null || line === "" || line.length > maxLength) throw invalidInput(`\`${label}\` must be a text of at most ${maxLength} characters`);
  return line;
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== "";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
