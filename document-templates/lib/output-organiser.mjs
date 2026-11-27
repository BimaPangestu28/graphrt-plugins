/**
 * Files documents into DOCUMENT_TEMPLATES_OUTPUT_DIR under a predictable
 * folder and name, e.g. `2026/11/INV-2026-0042.pdf`.
 *
 * The folder and file name come from patterns with tokens ({YYYY}, {MM},
 * {DD}, {number}, {client}, {template}, {values.any.path}). Every token value
 * and every pattern segment is reduced to a plain file name, so a value such
 * as "../../etc" or "a/b" can never leave the output directory or add a
 * level. Folders are created one level at a time under the realpath-checked
 * output directory, and re-checked after each step.
 *
 * A document is written to a private staging file next to its target and
 * published with link(), which never replaces a file: an existing document
 * is kept unless the call asks for a numbered copy or (nodes only) an
 * overwrite, which replaces a plain regular file atomically with rename().
 */
import { randomBytes } from "node:crypto";
import { promises as defaultFileSystem } from "node:fs";
import { join, sep } from "node:path";
import { invalidInput, operationFailed, permissionDenied, setupRequired } from "./errors.mjs";
import { parseIsoDate } from "./formatting.mjs";

export const DEFAULT_FOLDER_PATTERN = "{YYYY}/{MM}";
export const IF_EXISTS_CHOICES = ["error", "number", "overwrite"];
const OUTPUT_DIR_VARIABLE = "DOCUMENT_TEMPLATES_OUTPUT_DIR";
const MAX_FOLDER_DEPTH = 6;
const MAX_SEGMENT_LENGTH = 80;
const MAX_NUMBERED_COPIES = 99;
const STAGING_FILE_MODE = 0o600;
const OUTPUT_FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const TOKEN_PATTERN = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Schemas of the parameters shared by every operation that files a document. */
export const FILING_PARAMETERS = {
  folder: {
    type: "string",
    description: "Folder inside DOCUMENT_TEMPLATES_OUTPUT_DIR, as a pattern (default \"{YYYY}/{MM}\", the document's year and month). Tokens: {YYYY} {MM} {DD} (from the values' `date`, else today), {number}, {client}, {template}, and {values.some.field}. Example: \"Invoices/{client}/{YYYY}\"",
  },
  file_name: {
    type: "string",
    description: "File name without extension, as a pattern with the same tokens (default \"{number}\" when the values have a number, else \"{template}-{YYYY}{MM}{DD}-{time}\")",
  },
  if_exists: {
    type: "string",
    enum: IF_EXISTS_CHOICES,
    default: "error",
    description: "When the file already exists: error (keep it and fail), number (save next to it as name-2, name-3, ...) or overwrite (replace it; workflow nodes only)",
  },
};

/**
 * Reduces a text to one safe file or folder name.
 *
 * @param rawText - Any text, e.g. a client name (string)
 * @returns The name with path separators, control and reserved characters replaced, at most 80 characters; "" when nothing is left (string)
 *
 * @example
 * toSafeSegment("PT Maju/Jaya: Tbk."); // "PT Maju-Jaya- Tbk"
 */
export function toSafeSegment(rawText) {
  const cleaned = String(rawText ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, MAX_SEGMENT_LENGTH)
    .replace(/^[\s.-]+|[\s.-]+$/g, "");
  return WINDOWS_RESERVED_NAME_PATTERN.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Builds the token values for a document.
 *
 * @param details - `{values, templateName, now}`; `now` is the current local time (object)
 * @returns `{tokens, values}` where tokens has YYYY, MM, DD, time, number, client and template (object)
 */
export function buildFilingTokens({ values, templateName, now }) {
  const documentDate = parseIsoDate(values?.date);
  const [year, month, day] = documentDate
    ? [documentDate.getUTCFullYear(), documentDate.getUTCMonth() + 1, documentDate.getUTCDate()]
    : [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const pad = (numericValue) => String(numericValue).padStart(2, "0");
  return {
    values: values ?? {},
    tokens: {
      YYYY: String(year),
      MM: pad(month),
      DD: pad(day),
      time: `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`,
      number: values?.number,
      client: values?.client?.name ?? values?.customer?.name,
      template: templateName,
    },
  };
}

/**
 * Resolves the folder and file name patterns of a call.
 *
 * @param request - `{folder, fileName, extension, filing}`; filing is from buildFilingTokens (object)
 * @returns `{folderSegments, fileStem, extension}` (object)
 * @throws PluginError kind `invalid_input` - When a token is unknown or empty, or a pattern is malformed
 */
export function resolveFilingPlan({ folder, fileName, extension, filing }) {
  const folderPattern = folder ?? DEFAULT_FOLDER_PATTERN;
  const hasNumber = toSafeSegment(filing.tokens.number) !== "";
  const namePattern = fileName ?? (hasNumber ? "{number}" : "{template}-{YYYY}{MM}{DD}-{time}");
  const folderSegments = folderPattern.split(/[\\/]+/).filter((segment) => segment.trim() !== "").map((segment) => fillSegment(segment, filing, "folder"));
  if (folderSegments.length > MAX_FOLDER_DEPTH) throw invalidInput(`\`folder\` has ${folderSegments.length} levels, over the limit of ${MAX_FOLDER_DEPTH}`);
  if (/[\\/]/.test(namePattern)) throw invalidInput("`file_name` must not contain / or \\; use `folder` for the folder");
  return { folderSegments, fileStem: fillSegment(namePattern, filing, "file_name"), extension };
}

function fillSegment(pattern, filing, parameterName) {
  // Checked on the pattern, not the result: a value may itself contain braces.
  if (/[{}]/.test(pattern.replace(TOKEN_PATTERN, ""))) throw invalidInput(`\`${parameterName}\` has a malformed token in ${JSON.stringify(pattern)}; tokens look like {YYYY} or {number}`);
  const filled = pattern.replace(TOKEN_PATTERN, (_match, tokenName) => {
    const tokenValue = toSafeSegment(readToken(tokenName, filing, parameterName));
    if (tokenValue === "") throw invalidInput(`\`${parameterName}\` uses {${tokenName}}, but the values have no usable text for it`);
    return tokenValue;
  });
  const segment = toSafeSegment(filled);
  if (segment === "") throw invalidInput(`\`${parameterName}\` resolves to an empty name`);
  return segment;
}

function readToken(tokenName, filing, parameterName) {
  if (Object.hasOwn(filing.tokens, tokenName)) return filing.tokens[tokenName];
  if (!tokenName.startsWith("values.")) throw invalidInput(`\`${parameterName}\` uses the unknown token {${tokenName}}; tokens: {${Object.keys(filing.tokens).join("} {")}} and {values.some.field}`);
  let value = filing.values;
  for (const key of tokenName.split(".").slice(1)) {
    value = value !== null && typeof value === "object" && Object.hasOwn(value, key) ? value[key] : undefined;
  }
  return typeof value === "object" ? undefined : value;
}

/**
 * Creates the organiser for one call.
 *
 * @param settings - File settings with `outputDirectory` and `maxOutputBytes` (object)
 * @param dependencies - `{fileSystem, randomSuffix}` overrides for tests (object, optional)
 * @returns `{saveDocument, assertCanSave, resolveOutputRoot}` (object)
 */
export function createOutputOrganiser(settings, dependencies = {}) {
  const context = {
    settings,
    fileSystem: dependencies.fileSystem ?? defaultFileSystem,
    randomSuffix: dependencies.randomSuffix ?? (() => randomBytes(4).toString("hex")),
  };
  return {
    saveDocument: (request) => saveDocument(context, request),
    assertCanSave: (request) => assertCanSave(context, request),
    resolveOutputRoot: () => resolveOutputRoot(context),
  };
}

/**
 * Checks the `if_exists` choice of a call before any work is done.
 *
 * @param ifExists - "error", "number" or "overwrite" (string)
 * @param source - "node" or "tool" (string)
 * @throws PluginError kind `permission_denied` - When a tool call asks to overwrite
 */
export function assertIfExistsAllowed(ifExists, source) {
  if (ifExists === "overwrite" && source !== "node") throw permissionDenied("`if_exists: overwrite` is for workflow nodes only; use `number` to save a numbered copy, or a new file name");
}

async function resolveOutputRoot({ settings, fileSystem }) {
  if (!settings.outputDirectory) throw setupRequired(`Set ${OUTPUT_DIR_VARIABLE} to the folder (absolute, or ~/...) where documents are saved`);
  const realRoot = await fileSystem.realpath(settings.outputDirectory).catch(() => null);
  const rootStats = realRoot ? await fileSystem.stat(realRoot) : null;
  if (!rootStats?.isDirectory()) throw setupRequired(`${OUTPUT_DIR_VARIABLE} (${settings.outputDirectory}) must be an existing folder`);
  return realRoot;
}

// Run before the document is drawn: an unset output folder or a taken name should not cost a render.
// saveDocument() still decides; link() there is what never replaces a file.
async function assertCanSave(context, { plan, ifExists }) {
  const realRoot = await resolveOutputRoot(context);
  if (ifExists !== "error") return;
  const fileName = `${plan.fileStem}.${plan.extension}`;
  const existing = await context.fileSystem.lstat(join(realRoot, ...plan.folderSegments, fileName)).catch(() => null);
  if (existing) throw alreadyExists(plan, fileName);
}

function alreadyExists(plan, fileName) {
  return invalidInput(`${JSON.stringify([...plan.folderSegments, fileName].join("/"))} already exists; nothing was saved. Use another number or file name, or \`if_exists: number\` to keep both`);
}

async function saveDocument(context, { plan, bytes, ifExists }) {
  if (bytes.length > context.settings.maxOutputBytes) {
    throw invalidInput(`The document is ${bytes.length} bytes, over the ${context.settings.maxOutputBytes}-byte limit (DOCUMENT_TEMPLATES_MAX_OUTPUT_BYTES); nothing was saved`);
  }
  const realRoot = await resolveOutputRoot(context);
  const directory = await ensureFolder(context, realRoot, plan.folderSegments);
  const stagingPath = join(directory, `.${plan.fileStem.slice(0, 40)}.${context.randomSuffix()}.partial`);
  try {
    await writeStagingFile(context.fileSystem, stagingPath, bytes);
    const published = await publish(context, { stagingPath, directory, plan, ifExists });
    const relativePath = [...plan.folderSegments, published.fileName].join("/");
    return { path: published.path, relative_path: relativePath, folder: plan.folderSegments.join("/"), file_name: published.fileName, size_bytes: bytes.length, replaced_existing: published.replacedExisting };
  } catch (saveError) {
    throw saveError?.kind ? saveError : operationFailed(`Could not save the document: ${saveError?.code ?? saveError?.message ?? saveError}`);
  } finally {
    await context.fileSystem.rm(stagingPath, { force: true }).catch((removeError) => {
      process.stderr.write(`document-templates: could not remove staging file: ${removeError.message}\n`);
    });
  }
}

// One mkdir at a time; each new level is realpath'd and must still be inside the output root (no symlinked folder leads out).
async function ensureFolder({ fileSystem }, realRoot, folderSegments) {
  let currentDirectory = realRoot;
  for (const segment of folderSegments) {
    const nextPath = join(currentDirectory, segment);
    await fileSystem.mkdir(nextPath, { mode: DIRECTORY_MODE }).catch((mkdirError) => {
      if (mkdirError?.code !== "EEXIST") throw operationFailed(`Could not create the folder ${JSON.stringify(segment)}: ${mkdirError.code ?? mkdirError.message}`);
    });
    const realNext = await fileSystem.realpath(nextPath);
    const isInsideRoot = realNext.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`);
    if (!isInsideRoot || !(await fileSystem.stat(realNext)).isDirectory()) throw invalidInput(`The folder ${JSON.stringify(folderSegments.join("/"))} leads outside ${OUTPUT_DIR_VARIABLE} or is not a folder`);
    currentDirectory = realNext;
  }
  return currentDirectory;
}

async function writeStagingFile(fileSystem, stagingPath, bytes) {
  const fileHandle = await fileSystem.open(stagingPath, "wx", STAGING_FILE_MODE);
  try {
    await fileHandle.writeFile(bytes);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
  await fileSystem.chmod(stagingPath, OUTPUT_FILE_MODE);
}

async function publish(context, { stagingPath, directory, plan, ifExists }) {
  const candidateNames = [`${plan.fileStem}.${plan.extension}`];
  if (ifExists === "number") for (let copy = 2; copy <= MAX_NUMBERED_COPIES; copy += 1) candidateNames.push(`${plan.fileStem}-${copy}.${plan.extension}`);
  for (const fileName of candidateNames) {
    const targetPath = join(directory, fileName);
    try {
      await context.fileSystem.link(stagingPath, targetPath);
      return { path: targetPath, fileName, replacedExisting: false };
    } catch (linkError) {
      if (linkError?.code !== "EEXIST") throw linkError;
    }
  }
  const fileName = candidateNames[0];
  if (ifExists === "number") throw invalidInput(`${JSON.stringify(fileName)} and ${MAX_NUMBERED_COPIES - 1} numbered copies already exist; nothing was saved`);
  if (ifExists !== "overwrite") throw alreadyExists(plan, fileName);
  return replaceExisting(context.fileSystem, stagingPath, join(directory, fileName), fileName);
}

async function replaceExisting(fileSystem, stagingPath, targetPath, fileName) {
  const existingStats = await fileSystem.lstat(targetPath);
  if (!existingStats.isFile() || existingStats.nlink > 1) throw invalidInput(`${JSON.stringify(fileName)} is not a plain file (a link, a folder or a file with several hard links) and cannot be overwritten`);
  await fileSystem.rename(stagingPath, targetPath);
  return { path: targetPath, fileName, replacedExisting: true };
}
