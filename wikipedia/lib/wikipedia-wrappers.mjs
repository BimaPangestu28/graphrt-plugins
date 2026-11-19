/**
 * Wikipedia-specific additions to the declarative operations:
 *   - withLanguage: a `language` argument that sends one call to another language's wiki
 *     (https://<language>.wikipedia.org). Only plain wiki codes are accepted, so the host always stays on
 *     wikipedia.org.
 *   - capPageContent: `get_page_content` returns at most `max_chars` of plain text (articles can be several
 *     hundred thousand characters), and a missing page becomes a not_found error instead of an empty result.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const LANGUAGE_ENV = "WIKIPEDIA_LANGUAGE";
const DEFAULT_LANGUAGE = "en";
// Wiki subdomains: "en", "id", "simple", "zh-yue", "be-tarask", "zh-min-nan".
const LANGUAGE_PATTERN = /^[a-z]{2,12}(-[a-z]{1,12}){0,3}$/;
const DEFAULT_MAX_CHARS = 20000;
const LANGUAGE_PROPERTY = {
  type: "string",
  description: `Wikipedia language code, e.g. en, id, de, ja, simple (default: ${LANGUAGE_ENV} or ${DEFAULT_LANGUAGE})`,
};
const MAX_CHARS_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: 500000,
  default: DEFAULT_MAX_CHARS,
  description: `Return at most this many characters of text (default ${DEFAULT_MAX_CHARS})`,
};

/**
 * Builds the base URL of a language's Wikipedia.
 *
 * @param language - Wiki code such as "en" or "zh-yue" (string)
 * @returns Base URL, e.g. "https://id.wikipedia.org" (string)
 * @throws PluginError kind `invalid_input` - When the code is not a plain wiki code
 */
export function buildWikipediaUrl(language) {
  if (typeof language !== "string" || !LANGUAGE_PATTERN.test(language)) {
    throw new PluginError(`Invalid Wikipedia language ${JSON.stringify(language)}: use a wiki code such as en, id or zh-yue`, { kind: "invalid_input" });
  }
  return `https://${language}.wikipedia.org`;
}

/**
 * Resolves the plugin's default base URL from WIKIPEDIA_LANGUAGE (default en).
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 * @throws PluginError kind `invalid_input` - When WIKIPEDIA_LANGUAGE is not a plain wiki code
 */
export function resolveWikipediaUrl(environment) {
  return buildWikipediaUrl(environment?.[LANGUAGE_ENV]?.trim() || DEFAULT_LANGUAGE);
}

/**
 * Adds a `language` argument that sends the call to that language's Wikipedia.
 *
 * @param operation - Declarative operation (object)
 * @returns Operation with the wider schema and a run that switches the host (object)
 */
export function withLanguage(operation) {
  const parameters = { ...operation.parameters, properties: { ...operation.parameters.properties, language: LANGUAGE_PROPERTY } };
  const run = (context) => {
    const { language, ...args } = context.args;
    const client = language === undefined ? context.client : context.client.clientFor(buildWikipediaUrl(language));
    return operation.run({ ...context, client, args });
  };
  return { ...operation, parameters, run };
}

/**
 * Caps get_page_content's text at `max_chars` and turns a missing page into not_found.
 *
 * @param operation - The get_page_content operation (object)
 * @returns Operation with a `max_chars` argument (object)
 */
export function capPageContent(operation) {
  const parameters = { ...operation.parameters, properties: { ...operation.parameters.properties, max_chars: MAX_CHARS_PROPERTY } };
  const run = async (context) => {
    const { max_chars: maxChars, ...args } = context.args;
    // MediaWiki treats any value of a boolean parameter as true, including "false", so false must not be sent.
    if (args.intro_only === false) delete args.intro_only;
    const result = await operation.run({ ...context, args });
    return { ...result, data: truncateExtract(result.data, maxChars ?? DEFAULT_MAX_CHARS, args.page_title) };
  };
  return { ...operation, parameters, run };
}

function truncateExtract(page, maxChars, requestedTitle) {
  if (!page || page.missing || page.invalid || typeof page.extract !== "string") {
    throw new PluginError(`Wikipedia has no page ${JSON.stringify(page?.title ?? requestedTitle)}${page?.invalidreason ? `: ${page.invalidreason}` : ""}`, { kind: "not_found" });
  }
  const totalChars = page.extract.length;
  return { ...page, extract: page.extract.slice(0, maxChars), truncated: totalChars > maxChars, total_chars: totalChars };
}
