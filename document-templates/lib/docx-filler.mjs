/**
 * Word documents (.docx) with placeholders, filled with docxtemplater.
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
  const details = (templateError?.properties?.errors ?? [templateError]).slice(0, MAX_REPORTED_ERRORS).map((error) => error?.properties?.explanation ?? error?.message ?? String(error));
  return invalidInput(`The Word template has a problem with its placeholders: ${details.join("; ")}`);
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
  const document = createDocument(Docxtemplater, zip, settings);
  try {
    document.render(values);
  } catch (renderError) {
    throw describeTemplateError(renderError);
  }
  return { data: {}, outputs: [document.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" })] };
}
