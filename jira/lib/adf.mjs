/**
 * Plain text to Atlassian Document Format (ADF) for Jira Cloud REST v3, which only accepts ADF for comment bodies
 * and rich-text fields such as `description`. `acceptPlainText` adds a plain-text parameter next to an ADF one on
 * declarative operations, so agents and workflows can pass text while ADF stays available for formatting.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

/**
 * Converts plain text to an ADF document: blank lines separate paragraphs, single line breaks become hardBreaks.
 *
 * @param text - Plain text (string)
 * @returns ADF document `{type: "doc", version: 1, content}` (object)
 *
 * @example
 * textToAdf("Hi\nthere"); // {type:"doc",version:1,content:[{type:"paragraph",content:[{type:"text",text:"Hi"},{type:"hardBreak"},{type:"text",text:"there"}]}]}
 */
export function textToAdf(text) {
  const paragraphs = String(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((paragraphText) => paragraphText.split("\n").filter((line) => line.trim() !== ""))
    .filter((lines) => lines.length > 0);
  return { type: "doc", version: 1, content: paragraphs.map(buildParagraph) };
}

function buildParagraph(lines) {
  const inlineNodes = lines.flatMap((line, lineIndex) => (lineIndex === 0 ? [] : [{ type: "hardBreak" }]).concat({ type: "text", text: line }));
  return { type: "paragraph", content: inlineNodes };
}

/**
 * Returns the definition with plain-text parameters added to operations that take an ADF parameter.
 *
 * @param pluginDefinition - Definition from defineRestPlugin (object)
 * @param plainTextFields - `[{operationName, textParam, adfParam, required?}]`; `required` means one of the two (object[])
 * @returns A new definition; restSpec is unchanged (object)
 * @throws Error - An operation or its ADF parameter does not exist
 *
 * @example
 * acceptPlainText(definition, [{ operationName: "add_comment", textParam: "text", adfParam: "body", required: true }]);
 */
export function acceptPlainText(pluginDefinition, plainTextFields) {
  const fieldsByOperation = new Map(plainTextFields.map((field) => [field.operationName, field]));
  for (const field of plainTextFields) assertAdfParamExists(pluginDefinition, field);
  const operations = pluginDefinition.operations.map((operation) => {
    const field = fieldsByOperation.get(operation.name);
    return field ? addPlainTextParam(operation, field) : operation;
  });
  return { ...pluginDefinition, operations };
}

function assertAdfParamExists(pluginDefinition, { operationName, adfParam }) {
  const operation = pluginDefinition.operations.find((candidate) => candidate.name === operationName);
  if (!operation?.parameters.properties[adfParam]) throw new Error(`${pluginDefinition.name}: acceptPlainText: ${operationName} has no parameter ${adfParam}`);
}

function addPlainTextParam(operation, field) {
  const textProperty = { type: "string", description: `Plain text for \`${field.adfParam}\` (blank lines separate paragraphs); use \`${field.adfParam}\` for ADF formatting instead` };
  const parameters = { ...operation.parameters, properties: { ...operation.parameters.properties, [field.textParam]: textProperty } };
  return { ...operation, parameters, run: (context) => operation.run({ ...context, args: convertPlainText(context.args, field) }) };
}

function convertPlainText(args, { textParam, adfParam, required }) {
  const hasText = args[textParam] !== undefined;
  const hasAdf = args[adfParam] !== undefined;
  if (hasText && hasAdf) throw new PluginError(`Pass either \`${textParam}\` (plain text) or \`${adfParam}\` (ADF), not both`, { kind: "invalid_input" });
  if (!hasText && !hasAdf && required) throw new PluginError(`\`${textParam}\` (plain text) or \`${adfParam}\` (ADF) is required`, { kind: "invalid_input" });
  if (!hasText) return args;
  if (String(args[textParam]).trim() === "") throw new PluginError(`\`${textParam}\` is empty; Jira needs some text`, { kind: "invalid_input" });
  const { [textParam]: text, ...otherArgs } = args;
  return { ...otherArgs, [adfParam]: textToAdf(text) };
}
