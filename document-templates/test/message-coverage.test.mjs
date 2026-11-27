/**
 * Every message the plugin raises is either written in Indonesian too (lib/message-language.mjs) or on the list of
 * messages that stay in English on purpose, with the reason. The test reads the sources, so a new message that is
 * neither fails here until it is given an Indonesian text or a reason to stay English.
 *
 * Scanned: lib/*.mjs and operations/*.mjs (invalidInput, notFound, permissionDenied, operationFailed,
 * setupRequired, new PluginError, and *_MESSAGE constants). Not scanned: lib/shared/, the code every plugin shares
 * (argument checks against the operation's schema such as "`values` must be of type object"), which a workflow
 * builder or an AI caller reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { translateMessage } from "../lib/message-language.mjs";

const pluginDirectory = new URL("../", import.meta.url);
const RAISE_PATTERN = /(?:invalidInput|notFound|permissionDenied|operationFailed|setupRequired|new PluginError)\(\s*(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*")|(?:const|export const) ([A-Z_]+_MESSAGE) = ("(?:\\.|[^"\\])*")/g;

/** Why a message stays in English: who reads it is not the person making a document. */
const ENGLISH_REASONS = {
  "template-author": "the structure of a layout or Word template, read by whoever builds the template",
  "unopenable-file": "a file that cannot be opened at all (damaged zip or PDF, unreadable background, a value a form field cannot draw)",
  setup: "the plugin's setup: DOCUMENT_TEMPLATES_* settings, input folders, font files",
  internal: "a failure inside the plugin: worker crashed, out of memory, timeout, cancelled, could not draw",
  "unused-output": "output helpers of the shared file-access code that this plugin does not call (it saves through output-organiser.mjs)",
};

// [file, the message as written in the source, {sample} with a message it raises, or {english: reason}]
const MESSAGES = [
  ["lib/brand-profile.mjs", "`\\`name\\` must be a short name of letters and digits such as \"default\" or \"studio\", got ${JSON.stringify(rawName)}`", { sample: "`name` must be a short name of letters and digits such as \"default\" or \"studio\", got \"x\"" }],
  ["lib/brand-profile.mjs", "`Could not read the brand ${JSON.stringify(name)}: ${statError.code ?? statError.message}`", { sample: "Could not read the brand \"x\": X" }],
  ["lib/brand-profile.mjs", "`The saved brand ${JSON.stringify(name)} is damaged (${reason}). Save it again with save_brand and \\`reset: true\\``", { sample: "The saved brand \"x\" is damaged (X). Save it again with save_brand and `reset: true`" }],
  ["lib/brand-profile.mjs", "`There are already ${MAX_BRANDS} saved brands; save over one of them`", { sample: "There are already 5 saved brands; save over one of them" }],
  ["lib/brand-profile.mjs", "`Could not save the brand: ${writeError.code ?? writeError.message}`", { sample: "Could not save the brand: X" }],
  ["lib/brand-profile.mjs", "`There is no saved brand named ${JSON.stringify(name)}. save_brand creates one; leave \\`brand\\` out to use the default brand`", { sample: "There is no saved brand named \"x\". save_brand creates one; leave `brand` out to use the default brand" }],
  ["lib/brand-profile.mjs", "`Could not create the folder for brands: ${mkdirError.code ?? mkdirError.message}`", { sample: "Could not create the folder for brands: X" }],
  ["lib/brand-profile.mjs", "`${STATE_DIRECTORY_NAME}/${BRANDS_DIRECTORY_NAME} in your documents folder is not a plain folder; brands cannot be saved there`", { sample: "X/X in your documents folder is not a plain folder; brands cannot be saved there" }],
  ["lib/brand-profile.mjs", "\"`seller` must be an object such as {\\\"name\\\": \\\"CV Kenanga Digital\\\", \\\"address\\\": [\\\"Jalan Kenanga 12\\\", \\\"Bandung\\\"]}\"", { sample: "`seller` must be an object such as {\"name\": \"CV Kenanga Digital\", \"address\": [\"Jalan Kenanga 12\", \"Bandung\"]}" }],
  ["lib/brand-profile.mjs", "`\\`seller\\` does not know ${unknownFields.map((field) => JSON.stringify(field)).join(\", \")}; it takes ${allowedFields.join(\", \")} (a logo goes in \\`look\\`)`", { sample: "`seller` does not know \"x\"; it takes X (a logo goes in `look`)" }],
  ["lib/brand-profile.mjs", "`\\`payment_details\\` must be a list of at most ${MAX_PAYMENT_DETAILS} pairs such as [{\"label\": \"Bank\", \"value\": \"Example Bank\"}]`", { sample: "`payment_details` must be a list of at most 5 pairs such as [{\"label\": \"Bank\", \"value\": \"Example Bank\"}]" }],
  ["lib/brand-profile.mjs", "`\\`payment_details[${index}]\\` needs a \\`label\\` and a \\`value\\`, e.g. {\"label\": \"Bank\", \"value\": \"Example Bank\"}`", { sample: "`payment_details[5]` needs a `label` and a `value`, e.g. {\"label\": \"Bank\", \"value\": \"Example Bank\"}" }],
  ["lib/brand-profile.mjs", "`\\`${label}\\` has ${lines.length} lines, over the limit of ${MAX_LINES}`", { sample: "`seller.address` has 5 lines, over the limit of 5" }],
  ["lib/brand-profile.mjs", "`\\`${label}\\` must be a text of at most ${maxLength} characters`", { sample: "`seller.address` must be a text of at most 5 characters" }],
  ["lib/client.mjs", "`${FONTS_VARIABLE} lists ${fontPaths.length} fonts, over the limit of ${MAX_EXTRA_FONTS}`", { english: "setup" }],
  ["lib/client.mjs", "`${FONTS_VARIABLE}: ${JSON.stringify(fontPath)} must be a .ttf, .otf or .ttc font file`", { english: "setup" }],
  ["lib/decimal.mjs", "`\\`${label}\\` must be a plain number such as 1500000 or 1500000.50 (no thousands separators or currency symbols), got ${JSON.stringify(rawValue)}`", { sample: "`items[0].unit_price` must be a plain number such as 1500000 or 1500000.50 (no thousands separators or currency symbols), got \"x\"" }],
  ["lib/decimal.mjs", "`\\`${label}\\` is too large`", { sample: "`items[0].unit_price` is too large" }],
  ["lib/decimal.mjs", "`\\`${label}\\` must be a finite number`", { sample: "`items[0].unit_price` must be a finite number" }],
  ["lib/document-engine.mjs", "`Unknown document task ${JSON.stringify(task)}`", { english: "internal" }],
  ["lib/document-values.mjs", "\"Pass `values` or `values_file`, not both\"", { sample: "Pass `values` or `values_file`, not both" }],
  ["lib/document-values.mjs", "\"`values` is required: the document's values as an object, or `values_file` for a .json file\"", { sample: "`values` is required: the document's values as an object, or `values_file` for a .json file" }],
  ["lib/document-values.mjs", "`\\`values\\` is larger than ${MAX_VALUES_BYTES} bytes`", { sample: "`values` is larger than 5 bytes" }],
  ["lib/document-values.mjs", "`${label} is larger than ${MAX_VALUES_BYTES} bytes`", { sample: "`values_file` is larger than 2097152 bytes" }],
  ["lib/document-values.mjs", "`${label} is not valid JSON: ${parseError.message}`", { sample: "`values_file` is not valid JSON: Unexpected token } in JSON at position 9" }],
  ["lib/document-values.mjs", "`${label} must be a JSON object such as {\"number\": \"INV-2026-0001\"}`", { sample: "`values_file` must be a JSON object such as {\"number\": \"INV-2026-0001\"}" }],
  ["lib/docx-filler.mjs", "`The template is not a readable .docx file: ${zipError.message}`", { english: "unopenable-file" }],
  ["lib/docx-filler.mjs", "\"The template is not a Word document (.docx): it has no word/document.xml. Save .doc, .odt or .pages files as .docx first\"", { sample: "The template is not a Word document (.docx): it has no word/document.xml. Save .doc, .odt or .pages files as .docx first" }],
  ["lib/docx-filler.mjs", "\"The template contains macros (.docm); save it as a plain .docx without macros\"", { sample: "The template contains macros (.docm); save it as a plain .docx without macros" }],
  ["lib/docx-filler.mjs", "`The placeholder {{@${tag.trim()}}} inserts raw XML, which is not supported; use {{${tag.trim()}}}`", { english: "template-author" }],
  ["lib/docx-filler.mjs", "`The Word template has a problem with its placeholders: ${[...new Set(details)].join(\"; \")}`", { sample: "The Word template has a problem with its placeholders: X" }],
  ["lib/environment-readers.mjs", "`${variableName} must not contain line breaks or NUL characters`", { english: "setup" }],
  ["lib/environment-readers.mjs", "`${variableName} must be an integer from ${minimum} to ${maximum}, got ${JSON.stringify(rawValue)}`", { english: "setup" }],
  ["lib/environment-readers.mjs", "`${sourceName} must not contain NUL characters`", { english: "setup" }],
  ["lib/environment-readers.mjs", "`${sourceName}: path ${JSON.stringify(configuredPath)} must be absolute or start with ~/`", { english: "setup" }],
  ["lib/environment-readers.mjs", "`${variableName} must be an absolute path to the ${defaultName} executable`", { english: "setup" }],
  ["lib/errors.mjs", "`${what} was cancelled; no output was kept`", { english: "internal" }],
  ["lib/errors.mjs", "`${what} exceeded the ${timeoutMs} ms timeout and was stopped; no output was kept`", { english: "internal" }],
  ["lib/errors.mjs", "`The ${packageName} package is not installed: run \\`npm install\\` in the ${pluginName} plugin directory`", { english: "internal" }],
  ["lib/expressions.mjs", "`The template text ${JSON.stringify(text.slice(0, 80))} has a \\`{{\\` without a closing \\`}}\\``", { english: "template-author" }],
  ["lib/expressions.mjs", "`The placeholder {{${String(source).trim()}}} is a group of fields, not a text; name one field of it (for example ${String(source).trim().split(\"|\")[0].trim()}.name)`", { english: "template-author" }],
  ["lib/expressions.mjs", "`The number filter takes 0 to 10 decimals, got ${JSON.stringify(rawDigits)}`", { english: "template-author" }],
  ["lib/expressions.mjs", "`The placeholder {{${String(source).trim().slice(0, 80)}}} ${problem}`", { english: "template-author" }],
  ["lib/file-access.mjs", "`No file at ${JSON.stringify(rawPath)} inside ${context.settings.variables.inputDirs}`", { sample: "No file at \"x\" inside X" }],
  ["lib/file-access.mjs", "`Set ${settings.variables.inputDirs} to the directories (comma-separated, absolute) that input files may be read from`", { english: "setup" }],
  ["lib/file-access.mjs", "`\\`${parameterName}\\` must be a file path`", { sample: "`values_file` must be a file path" }],
  ["lib/file-access.mjs", "`\\`${parameterName}\\` must not contain NUL characters`", { sample: "`values_file` must not contain NUL characters" }],
  ["lib/file-access.mjs", "`${JSON.stringify(rawPath)} is not a regular file`", { sample: "\"x\" is not a regular file" }],
  ["lib/file-access.mjs", "`${JSON.stringify(rawPath)} has ${fileStats.nlink} hard links; copy it to a plain file first (hard links could point outside the allowed directories)`", { sample: "\"logo.png\" has 2 hard links; copy it to a plain file first (hard links could point outside the allowed directories)" }],
  ["lib/file-access.mjs", "`${JSON.stringify(rawPath)} is ${fileStats.size} bytes, over the ${settings.maxInputBytes}-byte limit (${settings.variables.maxInputBytes})`", { sample: "\"x\" is 5 bytes, over the 5-byte limit (5)" }],
  ["lib/file-access.mjs", "`\\`${parameterName}\\` must be a ${extensions.map((allowed) => `", { sample: "`values_file` must be a .json file" }],
  ["lib/file-access.mjs", "`Set ${variables.outputDir} to the directory (absolute) that output files are written to`", { english: "setup" }],
  ["lib/file-access.mjs", "`${variables.outputDir} (${outputDirectory}) must be an existing directory`", { english: "unused-output" }],
  ["lib/file-access.mjs", "`Could not create an output file in ${context.settings.variables.outputDir}: ${openError.message}`", { english: "unused-output" }],
  ["lib/file-access.mjs", "`Could not find a free output file name in ${context.settings.variables.outputDir}`", { english: "unused-output" }],
  ["lib/file-access.mjs", "`Could not move the output into ${context.settings.variables.outputDir}: ${linkError.message}`", { english: "unused-output" }],
  ["lib/file-access.mjs", "`Could not find a free output file name in ${context.settings.variables.outputDir}`", { english: "unused-output" }],
  ["lib/file-access.mjs", "`Could not write ${outputPath}: ${writeError.message}`", { english: "unused-output" }],
  ["lib/file-access.mjs", "`The output would be ${sizeBytes} bytes, over the ${settings.maxOutputBytes}-byte limit (${settings.variables.maxOutputBytes}); nothing was written`", { english: "unused-output" }],
  ["lib/fonts.mjs", "`The font ${basename(fontPath)} from DOCUMENT_TEMPLATES_FONTS could not be read: ${readError.code ?? readError.message}`", { english: "setup" }],
  ["lib/fonts.mjs", "`The font ${basename(fontPath)} from DOCUMENT_TEMPLATES_FONTS is not a usable .ttf, .otf or .ttc file: ${parseError.message}`", { english: "setup" }],
  ["lib/fonts.mjs", "`No available font has these characters: ${shown.join(\", \")}${more}. The built-in fonts cover Latin, Vietnamese, Cyrillic and Greek; for other scripts set DOCUMENT_TEMPLATES_FONTS to a font file (.ttf, .otf or .ttc) that has them`", { sample: "No available font has these characters: XX. The built-in fonts cover Latin, Vietnamese, Cyrillic and Greek; for other scripts set DOCUMENT_TEMPLATES_FONTS to a font file (.ttf, .otf or .ttc) that has them" }],
  ["lib/formatting.mjs", "`\\`${label}\\` must be one of ${choices.join(\", \")}, got ${JSON.stringify(rawValue)}`", { sample: "`currency_style` must be one of X, got \"x\"" }],
  ["lib/formatting.mjs", "`\\`locale\\` must be a language tag such as en-GB or id-ID, got ${JSON.stringify(rawValue)}`", { sample: "`locale` must be a language tag such as en-GB or id-ID, got \"x\"" }],
  ["lib/formatting.mjs", "`\\`currency\\` must be a three-letter code such as IDR or USD, got ${JSON.stringify(rawValue)}`", { sample: "`currency` must be a three-letter code such as IDR or USD, got \"x\"" }],
  ["lib/formatting.mjs", "`\\`decimals\\` must be an integer from 0 to ${MAX_DECIMALS}, got ${JSON.stringify(rawValue)}`", { sample: "`decimals` must be an integer from 0 to 5, got \"x\"" }],
  ["lib/formatting.mjs", "`Unknown date style ${JSON.stringify(style)}; use long, medium, short or iso`", { english: "template-author" }],
  ["lib/invoice-totals.mjs", "\"`values.items` must be a list of line items\"", { sample: "`values.items` must be a list of line items" }],
  ["lib/invoice-totals.mjs", "`\\`values.items\\` has ${values.items.length} entries, over the limit of ${MAX_ITEMS}`", { sample: "`values.items` has 5 entries, over the limit of 5" }],
  ["lib/invoice-totals.mjs", "`\\`${label}\\` must be an object with a description and an amount, or a quantity and unit_price`", { sample: "`items[0].discount` must be an object with a description and an amount, or a quantity and unit_price" }],
  ["lib/invoice-totals.mjs", "`\\`${label}\\` needs \\`amount\\`, or \\`quantity\\` and \\`unit_price\\``", { sample: "`items[0].discount` needs `amount`, or `quantity` and `unit_price`" }],
  ["lib/invoice-totals.mjs", "`\\`${label}.amount\\` is ${formatDecimal(given, decimals)} but quantity x unit_price less its discount is ${formatDecimal(computed, decimals)}; correct one of them or leave \\`amount\\` out`", { sample: "`items[0].discount.amount` is X but quantity x unit_price less its discount is X; correct one of them or leave `amount` out" }],
  ["lib/invoice-totals.mjs", "`\\`${label}.unit_price\\` is required when \\`quantity\\` is given`", { sample: "`items[0].discount.unit_price` is required when `quantity` is given" }],
  ["lib/invoice-totals.mjs", "`\\`${label}\\` takes \\`percent\\` or \\`amount\\`, not both`", { sample: "`items[0].discount` takes `percent` or `amount`, not both" }],
  ["lib/invoice-totals.mjs", "`\\`${label}\\` must be a number, or an object with \\`percent\\` or \\`amount\\``", { sample: "`items[0].discount` must be a number, or an object with `percent` or `amount`" }],
  ["lib/invoice-totals.mjs", "`\\`${label}\\` must not be negative`", { sample: "`items[0].discount` must not be negative" }],
  ["lib/invoice-totals.mjs", "\"`taxes` must be a list such as [{\\\"name\\\": \\\"PPN\\\", \\\"rate\\\": 11}]\"", { sample: "`taxes` must be a list such as [{\"name\": \"PPN\", \"rate\": 11}]" }],
  ["lib/invoice-totals.mjs", "`\\`taxes\\` has ${rawTaxes.length} entries, over the limit of ${MAX_TAXES}`", { sample: "`taxes` has 5 entries, over the limit of 5" }],
  ["lib/invoice-totals.mjs", "`\\`taxes[${index}]\\` needs \\`name\\` and \\`rate\\` (a percentage; negative for a withholding)`", { sample: "`taxes[5]` needs `name` and `rate` (a percentage; negative for a withholding)" }],
  ["lib/invoice-totals.mjs", "`\\`${label}\\` must be a percentage from -100 to 100`", { sample: "`items[0].discount` must be a percentage from -100 to 100" }],
  ["lib/isolated-task.mjs", "`Could not start the ${setup.displayName} worker: ${spawnError.message}`", { english: "internal" }],
  ["lib/isolated-task.mjs", "`${setup.displayName} used ${usedMb} MB, over the ${maxMemoryMb} MB budget (${setup.memoryVariable}), and was stopped; the file is too large or crafted to expand`", { english: "internal" }],
  ["lib/isolated-task.mjs", "`The ${setup.displayName} worker stopped unexpectedly (${reason}); the file may be malformed or need more than ${maxMemoryMb} MB (${setup.memoryVariable})`", { english: "internal" }],
  ["lib/layout-template.mjs", "`The template ${label} is not valid JSON: ${parseError.message}`", { english: "template-author" }],
  ["lib/layout-template.mjs", "`The template ${label} is not a layout template: it needs \"format\": \"${TEMPLATE_FORMAT}\"`", { english: "template-author" }],
  ["lib/layout-template.mjs", "`The template ${label} is version ${JSON.stringify(template.version)}; this plugin reads version ${TEMPLATE_VERSION}`", { english: "template-author" }],
  ["lib/layout-template.mjs", "`The template ${label} has unknown top-level keys: ${unknownKeys.join(\", \")} (allowed: ${TOP_LEVEL_KEYS.join(\", \")})`", { english: "template-author" }],
  ["lib/layout-template.mjs", "`The template ${label} needs a \"content\" list`", { english: "template-author" }],
  ["lib/layout-template.mjs", "`The template ${label} has \"calculate\": ${JSON.stringify(template.calculate)}; use \"invoice\" or \"none\"`", { english: "template-author" }],
  ["lib/layout-template.mjs", "`The document has more than ${MAX_NODES} parts after its loops are unrolled; shorten the list it loops over`", { english: "template-author" }],
  ["lib/layout-template.mjs", "`Template: \\`${path}\\` ${problem}`", { english: "template-author" }],
  ["lib/logo-file.mjs", "`${label} is ${describeSize(bytes.length)}; a logo may be at most 2 MB. Save a smaller version of it (about 800 pixels wide is plenty)`", { sample: "The logo \"logo.png\" is 5; a logo may be at most 2 MB. Save a smaller version of it (about 800 pixels wide is plenty)" }],
  ["lib/logo-file.mjs", "`${label} is not a usable picture: it is damaged or smaller than ${MIN_LOGO_SIDE_PIXELS} pixels`", { sample: "The logo \"logo.png\" is not a usable picture: it is damaged or smaller than 5 pixels" }],
  ["lib/logo-file.mjs", "`${label} is ${size.width} x ${size.height} pixels; a logo may be at most ${MAX_LOGO_SIDE_PIXELS} pixels on each side. Save a smaller version of it (about 800 pixels wide is plenty)`", { sample: "The logo \"logo.png\" is 5 x 5 pixels; a logo may be at most 5 pixels on each side. Save a smaller version of it (about 800 pixels wide is plenty)" }],
  ["lib/look-options.mjs", "`\\`${label}\\` must be an object such as {\"accent_color\": \"navy\", \"title\": \"Tax Invoice\"}`", { sample: "`look.accent_color` must be an object such as {\"accent_color\": \"navy\", \"title\": \"Tax Invoice\"}" }],
  ["lib/look-options.mjs", "`\\`${label}\\` does not know ${unknownKeys.map((key) => JSON.stringify(key)).join(\", \")}; it takes ${LOOK_KEYS.join(\", \")}`", { sample: "`look.accent_color` does not know \"x\"; it takes X" }],
  ["lib/look-options.mjs", "`\\`${label}\\` must be a colour such as #1D4ED8, or one of these names: ${listColorNames()}; got ${JSON.stringify(rawColor)}`", { sample: "`look.accent_color` must be a colour such as #1D4ED8, or one of these names: X; got \"x\"" }],
  ["lib/look-options.mjs", "`\\`${label}\\` ${JSON.stringify(rawColor)} is too light: the business name and the total are printed in this colour on a white page and could not be read. Choose a darker shade`", { sample: "`look.accent_color` \"x\" is too light: the business name and the total are printed in this colour on a white page and could not be read. Choose a darker shade" }],
  ["lib/look-options.mjs", "`\\`${label}\\` must be the path of a PNG or JPEG file in your templates folder, e.g. \"logo.png\"`", { sample: "`look.accent_color` must be the path of a PNG or JPEG file in your templates folder, e.g. \"logo.png\"" }],
  ["lib/look-options.mjs", "`\\`${label}\\` must be a text of at most ${maxLength} characters`", { sample: "`look.accent_color` must be a text of at most 5 characters" }],
  ["lib/look-options.mjs", "`\\`${label}\\` must be en (English) or id (Indonesian), got ${JSON.stringify(rawLanguage)}`", { sample: "`look.accent_color` must be en (English) or id (Indonesian), got \"x\"" }],
  ["lib/look-options.mjs", "`\\`${label}\\` must be an object of label names and their texts, e.g. {\"tax\": \"PPN\", \"bill_to\": \"Customer\"}`", { sample: "`look.accent_color` must be an object of label names and their texts, e.g. {\"tax\": \"PPN\", \"bill_to\": \"Customer\"}" }],
  ["lib/look-options.mjs", "`\\`${label}\\` has the invalid label name ${JSON.stringify(name)}; describe_template lists the names, e.g. tax, bill_to, total_due`", { sample: "`look.accent_color` has the invalid label name \"x\"; describe_template lists the names, e.g. tax, bill_to, total_due" }],
  ["lib/look-options.mjs", "`\\`${label}\\` must be an object such as {\"notes\": false}; it takes ${SHOW_PARTS.join(\", \")}`", { sample: "`look.accent_color` must be an object such as {\"notes\": false}; it takes X" }],
  ["lib/look-options.mjs", "`\\`${label}\\` does not know ${JSON.stringify(part)}; it takes ${SHOW_PARTS.join(\", \")}`", { sample: "`look.accent_color` does not know \"x\"; it takes X" }],
  ["lib/look-options.mjs", "`\\`${label}.${part}\\` must be true or false, got ${JSON.stringify(rawChoice)}`", { sample: "`look.show.notes` must be true or false, got \"maybe\"" }],
  ["lib/number-sequence.mjs", "`\\`pattern\\` must be a text of at most ${MAX_PATTERN_LENGTH} characters such as ${DEFAULT_NUMBER_PATTERN}`", { sample: "`pattern` must be a text of at most 5 characters such as X" }],
  ["lib/number-sequence.mjs", "\"`pattern` needs exactly one {SEQ} token (or {SEQ:4} for four digits), e.g. INV-{YYYY}-{SEQ:4}\"", { sample: "`pattern` needs exactly one {SEQ} token (or {SEQ:4} for four digits), e.g. INV-{YYYY}-{SEQ:4}" }],
  ["lib/number-sequence.mjs", "\"`pattern` may use letters, digits, spaces, . _ - / # and the tokens {YYYY} {YY} {MM} {DD} {ROMAN} {SEQ}\"", { sample: "`pattern` may use letters, digits, spaces, . _ - / # and the tokens {YYYY} {YY} {MM} {DD} {ROMAN} {SEQ}" }],
  ["lib/number-sequence.mjs", "`\\`date\\` must be a date such as 2026-11-27, got ${JSON.stringify(rawDate)}`", { sample: "`date` must be a date such as 2026-11-27, got \"x\"" }],
  ["lib/number-sequence.mjs", "`The numbering file already has ${MAX_COUNTERS} counters; remove old ones from ${STATE_DIRECTORY_NAME}/${STATE_FILE_NAME}`", { sample: "The numbering file already has 5 counters; remove old ones from X/X" }],
  ["lib/number-sequence.mjs", "`The numbering file already has ${MAX_COUNTERS} counters; remove old ones from ${STATE_DIRECTORY_NAME}/${STATE_FILE_NAME}`", { sample: "The numbering file already has 5 counters; remove old ones from X/X" }],
  ["lib/number-sequence.mjs", "`The document was not saved, and the number ${format(sequence)} could not be given back (${restoreError.message}); the next document gets the number after it`", { sample: "The document was not saved, and the number X could not be given back (X); the next document gets the number after it" }],
  ["lib/number-sequence.mjs", "`The counter ${JSON.stringify(counterName)} in ${STATE_DIRECTORY_NAME}/${STATE_FILE_NAME} has an invalid value`", { sample: "The counter \"x\" in X/X has an invalid value" }],
  ["lib/number-sequence.mjs", "`Could not read the numbering file: ${readError.code ?? readError.message}`", { sample: "Could not read the numbering file: X" }],
  ["lib/number-sequence.mjs", "`${STATE_DIRECTORY_NAME}/${STATE_FILE_NAME} is damaged (${parseError.message}); repair or remove it, then pass \\`start_at\\` to continue the numbering`", { sample: "X/X is damaged (X); repair or remove it, then pass `start_at` to continue the numbering" }],
  ["lib/number-sequence.mjs", "`Could not write the numbering file: ${writeError.code ?? writeError.message}`", { sample: "Could not write the numbering file: X" }],
  ["lib/number-sequence.mjs", "`Could not lock the numbering file: ${lockError.code ?? lockError.message}`", { sample: "Could not lock the numbering file: X" }],
  ["lib/number-sequence.mjs", "\"Another call is issuing a number and did not finish within 5 seconds; try again\"", { sample: "Another call is issuing a number and did not finish within 5 seconds; try again" }],
  ["lib/output-organiser.mjs", "`\\`folder\\` has ${folderSegments.length} levels, over the limit of ${MAX_FOLDER_DEPTH}`", { sample: "`folder` has 5 levels, over the limit of 5" }],
  ["lib/output-organiser.mjs", "\"`file_name` must not contain / or \\\\; use `folder` for the folder\"", { sample: "`file_name` must not contain / or \\; use `folder` for the folder" }],
  ["lib/output-organiser.mjs", "`\\`${parameterName}\\` has a malformed token in ${JSON.stringify(pattern)}; tokens look like {YYYY} or {number}`", { sample: "`folder` has a malformed token in \"x\"; tokens look like {YYYY} or {number}" }],
  ["lib/output-organiser.mjs", "`\\`${parameterName}\\` uses {${tokenName}}, but the values have no usable text for it`", { sample: "`folder` uses {X}, but the values have no usable text for it" }],
  ["lib/output-organiser.mjs", "`\\`${parameterName}\\` resolves to an empty name`", { sample: "`folder` resolves to an empty name" }],
  ["lib/output-organiser.mjs", "`\\`${parameterName}\\` uses the unknown token {${tokenName}}; tokens: {${Object.keys(filing.tokens).join(\"} {\")}} and {values.some.field}`", { sample: "`folder` uses the unknown token {X}; tokens: {X {\")}} and {values.some.field}" }],
  ["lib/output-organiser.mjs", "\"`if_exists: overwrite` is for workflow nodes only; use `number` to save a numbered copy, or a new file name\"", { sample: "`if_exists: overwrite` is for workflow nodes only; use `number` to save a numbered copy, or a new file name" }],
  ["lib/output-organiser.mjs", "`Set ${OUTPUT_DIR_VARIABLE} to the folder (absolute, or ~/...) where documents are saved`", { sample: "Set X to the folder (absolute, or ~/...) where documents are saved" }],
  ["lib/output-organiser.mjs", "`${OUTPUT_DIR_VARIABLE} (${settings.outputDirectory}) must be an existing folder`", { sample: "X (X) must be an existing folder" }],
  ["lib/output-organiser.mjs", "`${JSON.stringify([...plan.folderSegments, fileName].join(\"/\"))} already exists; nothing was saved. Use another number or file name, or \\`if_exists: number\\` to keep both`", { sample: "\"x\" already exists; nothing was saved. Use another number or file name, or `if_exists: number` to keep both" }],
  ["lib/output-organiser.mjs", "`The document is ${bytes.length} bytes, over the ${context.settings.maxOutputBytes}-byte limit (DOCUMENT_TEMPLATES_MAX_OUTPUT_BYTES); nothing was saved`", { sample: "The document is 5 bytes, over the 5-byte limit (DOCUMENT_TEMPLATES_MAX_OUTPUT_BYTES); nothing was saved" }],
  ["lib/output-organiser.mjs", "`Could not save the document: ${saveError?.code ?? saveError?.message ?? saveError}`", { sample: "Could not save the document: X" }],
  ["lib/output-organiser.mjs", "`Could not create the folder ${JSON.stringify(segment)}: ${mkdirError.code ?? mkdirError.message}`", { sample: "Could not create the folder \"x\": X" }],
  ["lib/output-organiser.mjs", "`The folder ${JSON.stringify(folderSegments.join(\"/\"))} leads outside ${OUTPUT_DIR_VARIABLE} or is not a folder`", { sample: "The folder \"x\" leads outside X or is not a folder" }],
  ["lib/output-organiser.mjs", "`${JSON.stringify(fileName)} and ${MAX_NUMBERED_COPIES - 1} numbered copies already exist; nothing was saved`", { sample: "\"x\" and 5 numbered copies already exist; nothing was saved" }],
  ["lib/output-organiser.mjs", "`${JSON.stringify(fileName)} is not a plain file (a link, a folder or a file with several hard links) and cannot be overwritten`", { sample: "\"x\" is not a plain file (a link, a folder or a file with several hard links) and cannot be overwritten" }],
  ["lib/pdf-form.mjs", "\"The PDF is protected in a way that cannot be opened here. Ask whoever published it for a copy without protection\"", { sample: "The PDF is protected in a way that cannot be opened here. Ask whoever published it for a copy without protection" }],
  ["lib/pdf-form.mjs", "\"Whoever published this form has locked it against being filled in, so it is not filled in here either. With the form's permissions password (the one that lifts its restrictions, also called the owner password) given as `password` it can be filled in; without it, ask the publisher for a form that may be filled in\"", { sample: "Whoever published this form has locked it against being filled in, so it is not filled in here either. With the form's permissions password (the one that lifts its restrictions, also called the owner password) given as `password` it can be filled in; without it, ask the publisher for a form that may be filled in" }],
  ["lib/pdf-form.mjs", "\"This PDF is an XFA form (made with Adobe LiveCycle Designer; other programs show \\\"Please wait...\\\" instead of the form). XFA forms cannot be filled in here: only Adobe Acrobat reads them. Ask whoever published the form for a standard fillable PDF (AcroForm), or recreate the document as a layout template for render_pdf\"", { sample: "This PDF is an XFA form (made with Adobe LiveCycle Designer; other programs show \"Please wait...\" instead of the form). XFA forms cannot be filled in here: only Adobe Acrobat reads them. Ask whoever published the form for a standard fillable PDF (AcroForm), or recreate the document as a layout template for render_pdf" }],
  ["lib/pdf-form.mjs", "`The template is not a readable PDF: ${loadError.message}`", { sample: "The template is not a readable PDF: X" }],
  ["lib/pdf-form.mjs", "`The PDF has ${fields.length} form fields, over the limit of ${maxFields} (DOCUMENT_TEMPLATES_MAX_FORM_FIELDS)`", { sample: "The PDF has 5 form fields, over the limit of 5 (DOCUMENT_TEMPLATES_MAX_FORM_FIELDS)" }],
  ["lib/pdf-form.mjs", "\"This PDF has no fillable form fields. A PDF that is a picture or plain page content cannot be filled in; use the built-in invoice template, or a layout template with this PDF as its background\"", { sample: "This PDF has no fillable form fields. A PDF that is a picture or plain page content cannot be filled in; use the built-in invoice template, or a layout template with this PDF as its background" }],
  ["lib/pdf-form.mjs", "`The PDF has no form field named ${unknownNames.map((name) => JSON.stringify(name)).join(\", \")}. Its fields: ${[...fieldsByName.keys()].slice(0, 60).join(\", \")}`", { sample: "The PDF has no form field named \"x\". Its fields: X" }],
  ["lib/pdf-form.mjs", "`A value could not be drawn in its field: ${drawError.message}`", { english: "unopenable-file" }],
  ["lib/pdf-form.mjs", "`The value for ${JSON.stringify(name)} is longer than ${MAX_VALUE_LENGTH} characters`", { sample: "The value for \"x\" is longer than 5 characters" }],
  ["lib/pdf-form.mjs", "`The value for the form field ${JSON.stringify(name)} was not accepted: ${setError.message}`", { sample: "The value for the form field \"x\" was not accepted: X" }],
  ["lib/pdf-protection.mjs", "`The password that was given is not a password of ${label}. Check it and try again; a PDF that opens without a password needs none`", { sample: "The password that was given is not a password of the template. Check it and try again; a PDF that opens without a password needs none" }],
  ["lib/pdf-protection.mjs", "`A password is needed to open ${label}. Give it as \\`password\\`; it is used only to open the file and is not saved or shown anywhere`", { sample: "A password is needed to open the template. Give it as `password`; it is used only to open the file and is not saved or shown anywhere" }],
  ["lib/pdf-protection.mjs", "\"`password` must be a text\"", { sample: "`password` must be a text" }],
  ["lib/pdf-protection.mjs", "`\\`password\\` must be one line of at most ${MAX_PASSWORD_LENGTH} characters`", { sample: "`password` must be one line of at most 5 characters" }],
  ["lib/pdf-protection.mjs", "`Could not open ${label}, it is not a PDF that can be opened here: ${describeFailure(qpdfMessage)}`", { sample: "Could not open the template, it is not a PDF that can be opened here: X" }],
  ["lib/pdf-renderer.mjs", "`The document has ${rendered.pageCount} pages, over the ${maxPages}-page limit (DOCUMENT_TEMPLATES_MAX_PAGES)`", { sample: "The document has 5 pages, over the 5-page limit (DOCUMENT_TEMPLATES_MAX_PAGES)" }],
  ["lib/pdf-renderer.mjs", "`An image could not be read (${imageProblem[1]}); save it again as a PNG or JPEG`", { sample: "An image could not be read (X); save it again as a PNG or JPEG" }],
  ["lib/pdf-renderer.mjs", "`The document could not be drawn: ${message.split(\"\\n\")[0]}`", { english: "internal" }],
  ["lib/pdf-renderer.mjs", "`The template uses the font ${JSON.stringify(fontName)}; available fonts: ${Object.keys(fonts.families).join(\", \")}`", { english: "template-author" }],
  ["lib/pdf-renderer.mjs", "`The background PDF is not readable: ${loadError.message}`", { english: "unopenable-file" }],
  ["lib/pdf-renderer.mjs", "\"The background PDF is encrypted; save an unprotected copy first\"", { english: "unopenable-file" }],
  ["lib/pdf-renderer.mjs", "\"The background PDF has no pages\"", { english: "unopenable-file" }],
  ["lib/raster-format.mjs", "`${label} must be a ${allowedFormats.join(\", \")} image (detected from its content: ${detectedFormat ?? \"not a supported image\"})`", { sample: "The image \"photo.webp\" must be a X image (detected from its content: X)" }],
  ["lib/template-library.mjs", "`\\`template\\` must be a built-in template (${BUILT_IN_TEMPLATE_NAMES.join(\", \")}) or a .json, .docx, .dotx or .pdf file, got ${JSON.stringify(trimmed)}`", { sample: "`template` must be a built-in template (X) or a .json, .docx, .dotx or .pdf file, got \"x\"" }],
  ["lib/template-library.mjs", "`The layout template is ${file.bytes.length} bytes, over the limit of ${MAX_LAYOUT_BYTES}`", { sample: "The layout template is 5 bytes, over the limit of 5" }],
  ["lib/template-library.mjs", "`${JSON.stringify(templateArgument)} is ${KIND_HINTS[kind].what}; this operation takes ${allowedKinds.map((allowed) => KIND_HINTS[allowed].what).join(\" or \")}. Use ${KIND_HINTS[kind].operation} for it`", { sample: "\"report.docx\" is a Word document; this operation takes a layout template. Use fill_docx for it" }],
  ["lib/zip-inspection.mjs", "\"The file is not a valid .docx (broken zip directory)\"", { english: "unopenable-file" }],
  ["lib/zip-inspection.mjs", "\"The .docx uses zip64 entries (over 4 GiB), which are not supported\"", { english: "unopenable-file" }],
  ["lib/zip-inspection.mjs", "\"The file is not a valid .docx (no zip directory found)\"", { english: "unopenable-file" }],
  ["lib/zip-inspection.mjs", "\"The file is not a Word document (.docx): it is not a zip archive. Save .doc files as .docx first\"", { sample: "The file is not a Word document (.docx): it is not a zip archive. Save .doc files as .docx first" }],
  ["lib/zip-inspection.mjs", "`The .docx has ${entryCount} parts, over the limit of ${maxEntries}`", { english: "unopenable-file" }],
  ["lib/zip-inspection.mjs", "`The .docx would unpack to ${uncompressedBytes} bytes, over the ${maxUnzippedBytes}-byte limit`", { english: "unopenable-file" }],
  ["operations/brand-operations.mjs", "\"Give at least one thing to save: `look` (logo, accent_color, title, language, labels, show), `seller`, `payment_details` or `notes`\"", { sample: "Give at least one thing to save: `look` (logo, accent_color, title, language, labels, show), `seller`, `payment_details` or `notes`" }],
  ["operations/document-operations.mjs", "`\\`${parameterName}\\` is not a PDF file (no %PDF- header)`", { sample: "`background` is not a PDF file (no %PDF- header)" }],
  ["operations/document-operations.mjs", "\"Give the document's `number` in `values` or a `number_pattern`, not both\"", { sample: "Give the document's `number` in `values` or a `number_pattern`, not both" }],
  ["operations/document-operations.mjs", "`The ${template.name} template needs these values: ${missingFields.join(\", \")}. describe_template shows every field with an example`", { sample: "The X template needs these values: X. describe_template shows every field with an example" }],
  ["operations/document-operations.mjs", "`Other documents kept taking the next number of ${JSON.stringify(args.number_pattern)}; nothing was saved and no number was used. Try again`", { sample: "Other documents kept taking the next number of \"x\"; nothing was saved and no number was used. Try again" }],
  ["operations/document-operations.mjs", "\"Pass `fields` or `fields_file`, not both\"", { sample: "Pass `fields` or `fields_file`, not both" }],
  ["operations/document-operations.mjs", "\"`fields` is required: an object of form field names and their values (describe_template lists the names)\"", { sample: "`fields` is required: an object of form field names and their values (describe_template lists the names)" }],
  ["operations/document-operations.mjs", "`\\`fields\\` must name 1 to ${maxFormFields} form fields`", { sample: "`fields` must name 1 to 5 form fields" }],
  ["operations/document-operations.mjs", "`The value for the form field ${JSON.stringify(name)} must be a text, a number or true/false`", { sample: "The value for the form field \"x\" must be a text, a number or true/false" }],
  ["operations/template-operations.mjs", "`\\`template\\` must be a ready-made template (${BUILT_IN_TEMPLATE_NAMES.join(\", \")}), got ${JSON.stringify(args.template)}`", { sample: "`template` must be a ready-made template (X), got \"x\"" }],
  ["operations/template-operations.mjs", "\"`name` must have letters or digits, e.g. \\\"Quotation\\\"\"", { sample: "`name` must have letters or digits, e.g. \"Quotation\"" }],
];

function scanSources() {
  const files = [...readdirSync(new URL("lib/", pluginDirectory)).filter((name) => name.endsWith(".mjs")).map((name) => `lib/${name}`), ...readdirSync(new URL("operations/", pluginDirectory)).map((name) => `operations/${name}`)];
  return files.flatMap((file) => [...readFileSync(new URL(file, pluginDirectory), "utf8").matchAll(RAISE_PATTERN)].map((match) => [file, match[1] ?? match[3]]));
}

// The source text as a pattern: every ${...} stands for any text, an unfinished one for the rest of the message.
function toPattern(source) {
  const body = source.startsWith('"') ? JSON.parse(source) : source.slice(1, -1).replaceAll("\\`", "`").replaceAll("\\\\", "\\");
  const parts = [];
  let rest = body;
  for (;;) {
    const start = rest.indexOf("${");
    if (start === -1) { parts.push(escape(rest), "$"); break; }
    parts.push(escape(rest.slice(0, start)), "[\\s\\S]*");
    let depth = 0;
    let end = -1;
    for (let index = start + 1; index < rest.length; index += 1) {
      if (rest[index] === "{") depth += 1;
      else if (rest[index] === "}" && (depth -= 1) === 0) { end = index; break; }
    }
    if (end === -1) break;
    rest = rest.slice(end + 1);
  }
  return new RegExp(`^${parts.join("")}`);
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("every message the plugin raises has an Indonesian text or a reason to stay English", () => {
  const listed = new Set(MESSAGES.map(([file, source]) => `${file}\t${source}`));
  const found = new Set(scanSources().map(([file, source]) => `${file}\t${source}`));
  assert.deepEqual([...found].filter((key) => !listed.has(key)), [], "new messages: give each an Indonesian text in lib/message-language.mjs and a sample here, or a reason to stay English");
  assert.deepEqual([...listed].filter((key) => !found.has(key)), [], "messages listed here that the sources no longer raise");
});

test("each listed sample is what its source raises, and it has an Indonesian text", () => {
  for (const [file, source, { sample, english }] of MESSAGES) {
    if (english !== undefined) {
      assert.ok(Object.hasOwn(ENGLISH_REASONS, english), `${file}: unknown reason ${english}`);
      continue;
    }
    assert.match(sample, toPattern(source), `${file}: the sample does not fit ${source}`);
    const indonesian = translateMessage(sample, "id");
    assert.notEqual(indonesian, sample, `${file}: no Indonesian text for ${sample}`);
    assert.doesNotMatch(indonesian, /\b(must|should|is required|not both|already exists|could not|is not|needs|given)\b/i, indonesian);
  }
});
