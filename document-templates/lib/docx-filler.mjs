/**
 * Word documents (.docx) and Word templates (.dotx) with placeholders, filled with docxtemplater.
 *
 * The placeholders are the same as everywhere else in this plugin:
 * `{{client.name}}`, `{{totals.total | money}}`. A section repeats for every
 * entry of a list between `{{#items}}` and `{{/items}}` (in a table row, the
 * row repeats), shows only when a value is present, or with `{{^value}}`
 * only when it is absent. Placeholders are looked up by this plugin's own
 * parser (expressions.mjs): no expression is ever evaluated as code.
 *
 * The result is a .docx file. Turning a .docx into a PDF needs Word or
 * LibreOffice and is not done here.
 */
import { invalidInput } from "./errors.mjs";
import { Scope, evaluateExpression, parseExpression, toDisplayText } from "./expressions.mjs";
import { assertZipWithinLimits } from "./zip-inspection.mjs";

const ZIP_LIMITS = { maxUnzippedBytes: 200 * 1024 * 1024, maxEntries: 2000 };
const MAX_REPORTED_ERRORS = 8;
const MACRO_PART_PATTERN = /vbaProject/i;
const CONTENT_TYPES_PART = "[Content_Types].xml";
// A Word template file (.dotx) differs from a document (.docx) in this one content type.
const TEMPLATE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";
const DOCUMENT_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const TEXT_PART_PATTERN = /^word\/(?:document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const PLACEHOLDER_FLAG_PATTERN = /<w:showingPlcHdr\s*\/>/g;
const PART_NAMES = [[/^word\/header\d*\.xml$/, "the page header"], [/^word\/footer\d*\.xml$/, "the page footer"], [/^word\/footnotes\.xml$/, "a footnote"], [/^word\/endnotes\.xml$/, "an endnote"]];

async function openTemplate(bytes) {
  const buffer = Buffer.from(bytes);
  assertZipWithinLimits(buffer, ZIP_LIMITS);
  const [{ default: PizZip }, { default: Docxtemplater }] = await Promise.all([import("pizzip"), import("docxtemplater")]);
  let zip;
  try {
    zip = new PizZip(buffer);
  } catch (zipError) {
    throw invalidInput(`The template is not a readable .docx file: ${zipError.message}`);
  }
  if (!zip.file("word/document.xml")) throw invalidInput("The template is not a Word document (.docx): it has no word/document.xml. Save .doc, .odt or .pages files as .docx first");
  if (Object.keys(zip.files).some((entryName) => MACRO_PART_PATTERN.test(entryName))) throw invalidInput("The template contains macros (.docm); save it as a plain .docx without macros");
  return { zip, Docxtemplater };
}

function createDocument(Docxtemplater, zip, settings) {
  try {
    return new Docxtemplater(zip, {
      delimiters: { start: "{{", end: "}}" },
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => "",
      // Problems are reported through the thrown error; docxtemplater would also print each one.
      errorLogging: false,
      parser: (tag) => createTagReader(tag, settings),
    });
  } catch (templateError) {
    throw describeTemplateError(templateError);
  }
}

// docxtemplater asks for each tag's value with the current loop item and the enclosing scopes.
function createTagReader(tag, settings) {
  const expression = tag.trim() === "." ? null : parseExpression(tag);
  return {
    get(currentScope, context) {
      if (expression === null) return currentScope;
      // `{{@name}}` would paste a value into the document as raw XML.
      if (context.meta?.part?.module === "rawxml") throw invalidInput(`The placeholder {{@${tag.trim()}}} inserts raw XML, which is not supported; use {{${tag.trim()}}}`);
      let scope = null;
      for (const variables of context.scopeList) scope = new Scope(toVariables(variables), scope);
      const value = evaluateExpression(expression, scope ?? new Scope(toVariables(currentScope)), settings);
      const isTextTag = !context.meta?.part?.module;
      return isTextTag ? toDisplayText(value, tag) : value;
    },
  };
}

function toVariables(scopeValue) {
  return scopeValue !== null && typeof scopeValue === "object" && !Array.isArray(scopeValue) ? scopeValue : { item: scopeValue };
}

function describeTemplateError(templateError) {
  if (templateError?.kind) return templateError;
  const details = (templateError?.properties?.errors ?? [templateError]).slice(0, MAX_REPORTED_ERRORS).map(describePlaceholderProblem);
  return invalidInput(`The Word template has a problem with its placeholders: ${[...new Set(details)].join("; ")}`);
}

// A placeholder this plugin's parser refused carries its own message (which names the placeholder and what to
// write instead); docxtemplater's wording is used for its own findings, such as a tag that is never closed.
function describePlaceholderProblem(problem) {
  const properties = problem?.properties ?? {};
  const message = properties.rootError?.message ?? properties.explanation ?? problem?.message ?? String(problem);
  const partName = PART_NAMES.find(([pattern]) => pattern.test(properties.file ?? ""))?.[1];
  return partName ? `${message} (in ${partName})` : message;
}

// The result is always a document: a filled .dotx would otherwise open in Word as a new unnamed copy, and under
// the name .docx Word refuses a file that says it is a template.
function saveAsDocument(zip) {
  const contentTypes = zip.file(CONTENT_TYPES_PART)?.asText();
  if (contentTypes?.includes(TEMPLATE_CONTENT_TYPE)) zip.file(CONTENT_TYPES_PART, contentTypes.replaceAll(TEMPLATE_CONTENT_TYPE, DOCUMENT_CONTENT_TYPE));
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
}

// Microsoft's templates keep their grey "click here" texts in content controls marked `showingPlcHdr`: the content
// is only a placeholder. Word then selects the whole control on a click and throws the text away on the first key
// press, and may show it as empty. A control whose text holds a {{placeholder}} gets real content, so it loses the
// mark; every other control stays as it is.
function markFilledControls(zip) {
  for (const entryName of Object.keys(zip.files).filter((name) => TEXT_PART_PATTERN.test(name))) {
    const partXml = zip.file(entryName).asText();
    const updatedXml = removeFilledPlaceholderFlags(partXml);
    if (updatedXml !== partXml) zip.file(entryName, updatedXml);
  }
}

function removeFilledPlaceholderFlags(partXml) {
  let updatedXml = "";
  let copiedUpTo = 0;
  for (const flag of partXml.matchAll(PLACEHOLDER_FLAG_PATTERN)) {
    // The flag sits in the control's properties, right before that control's own content.
    const contentStart = partXml.indexOf("<w:sdtContent", flag.index);
    if (contentStart === -1) break;
    const contentText = readRunTexts(partXml.slice(contentStart, findContentEnd(partXml, contentStart)));
    if (!contentText.includes("{{")) continue;
    updatedXml += partXml.slice(copiedUpTo, flag.index);
    copiedUpTo = flag.index + flag[0].length;
  }
  return updatedXml + partXml.slice(copiedUpTo);
}

// Controls may hold controls: the content ends at the closing tag that matches its opening one.
function findContentEnd(partXml, contentStart) {
  const tagPattern = /<w:sdtContent[\s>]|<\/w:sdtContent>/g;
  tagPattern.lastIndex = contentStart;
  let depth = 0;
  for (let tag = tagPattern.exec(partXml); tag !== null; tag = tagPattern.exec(partXml)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return tag.index;
  }
  return partXml.length;
}

// Word may cut "{{" itself into two runs, so the runs' texts are joined before looking.
function readRunTexts(xml) {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join("");
}

/**
 * Lists the placeholders of a .docx template.
 *
 * @param request - `{bytes}` (object)
 * @returns `{data: {placeholders: string[], sections: string[]}}`; sections are the loop and condition tags (object)
 */
export async function inspectDocx({ bytes }) {
  const { zip, Docxtemplater } = await openTemplate(bytes);
  const document = createDocument(Docxtemplater, zip, {});
  const placeholders = new Set();
  const sections = new Set();
  // docxtemplater's own inspect module needs lodash, which it does not declare; its parsed parts say the same.
  const collect = (parts) => {
    for (const part of parts) {
      if (part.type === "placeholder") (part.module ? sections : placeholders).add(String(part.value).trim());
      if (Array.isArray(part.subparsed)) collect(part.subparsed);
    }
  };
  for (const compiledFile of Object.values(document.compiled ?? {})) collect(compiledFile.postparsed ?? []);
  return { data: { placeholders: [...placeholders].sort(), sections: [...sections].sort() } };
}

/**
 * Fills a .docx template.
 *
 * @param request - `{bytes, values, settings}`; settings from readFormatSettings (object)
 * @returns `{data: {}, outputs: [Uint8Array]}` (object)
 * @throws PluginError kind `invalid_input` - When the file is not a .docx or a placeholder is malformed
 */
export async function fillDocx({ bytes, values, settings }) {
  const { zip, Docxtemplater } = await openTemplate(bytes);
  markFilledControls(zip);
  const document = createDocument(Docxtemplater, zip, settings);
  try {
    document.render(values);
  } catch (renderError) {
    throw describeTemplateError(renderError);
  }
  return { data: {}, outputs: [saveAsDocument(document.getZip())] };
}
