/**
 * deepl plugin definition: the DeepL API (https://developers.deepl.com/api-reference) to translate and rephrase
 * text, translate documents, and read usage, languages and glossaries. Built with the declarative REST layer
 * (docs/declarative-plugins.md).
 *
 * Free-plan keys end in ":fx" and use api-free.deepl.com; others use api.deepl.com. DEEPL_API_URL overrides the
 * host (it must be a deepl.com host). Translating and rephrasing are billed per character, so they are "unsafe": a
 * 5xx or timeout is when DeepL may already have counted the characters, so they are never retried and the error says
 * to check get_usage. Free status checks stay "idempotent". A translated document can be downloaded only once, so
 * `download_document` is "unsafe" too.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const PRO_URL = "https://api.deepl.com";
const FREE_URL = "https://api-free.deepl.com";
const TRANSLATE_TIMEOUT_MS = 120000;
const PAID_CHECK_HINT = "the characters may have been billed; compare get_usage before retrying";
const FORMALITIES = ["default", "more", "less", "prefer_more", "prefer_less"];
const langParam = (description, required = false) => ({ in: "body", type: "string", ...(required ? { required: true } : {}), description });
const documentParams = {
  document_id: { in: "path", type: "string", required: true, description: "document_id from translate_document" },
  document_key: { in: "body", type: "string", required: true, description: "document_key from translate_document" },
};
const glossaryIdParam = { glossary_id: { in: "path", type: "string", required: true, description: "Glossary id" } };

/**
 * Picks the API host: DEEPL_API_URL, else api-free for ":fx" keys, else api.deepl.com.
 *
 * @param environment - Environment variables (object)
 * @returns Base URL (string)
 */
export function resolveDeeplUrl(environment) {
  const configuredUrl = environment.DEEPL_API_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/+$/, "");
  return environment.DEEPL_API_KEY?.trim().endsWith(":fx") ? FREE_URL : PRO_URL;
}

const translateText = {
  name: "translate_text",
  title: "Translate text",
  description: "Translate up to 50 texts into one language; translations[i].text belongs to text[i], with detected_source_language",
  method: "POST",
  path: "/v2/translate",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: TRANSLATE_TIMEOUT_MS,
  params: {
    text: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 50, description: "Texts to translate" },
    target_lang: langParam("Target language, e.g. EN-US, EN-GB, DE, ID, PT-BR (see list_languages type target)", true),
    source_lang: langParam("Source language, e.g. EN, ID (detected when omitted; required with glossary_id)"),
    context: { in: "body", type: "string", description: "Extra context that guides the translation but is not translated (not billed)" },
    formality: { in: "body", type: "string", enum: FORMALITIES, description: "Formal or informal tone (some languages); prefer_* falls back silently" },
    model_type: { in: "body", type: "string", enum: ["quality_optimized", "prefer_quality_optimized", "latency_optimized"], description: "Translation model" },
    glossary_id: { in: "body", type: "string", description: "Glossary to apply (needs source_lang)" },
    preserve_formatting: { in: "body", type: "boolean", description: "Keep punctuation and casing as is" },
    split_sentences: { in: "body", type: "string", enum: ["0", "1", "nonewlines"], description: "Sentence splitting: 0 off, 1 on (default), nonewlines" },
    tag_handling: { in: "body", type: "string", enum: ["xml", "html"], description: "Translate XML or HTML and keep the markup" },
    custom_instructions: { in: "body", type: "array", items: { type: "string" }, maxItems: 10, description: "Short instructions, e.g. 'Use British spelling' (quality_optimized model)" },
    show_billed_characters: { in: "body", type: "boolean", description: "Return billed_characters per text" },
  },
};

const rephraseText = {
  name: "rephrase_text",
  title: "Rephrase text (DeepL Write)",
  description: "Improve or restyle texts with DeepL Write (Pro plans); improvements[i].text belongs to text[i]",
  method: "POST",
  path: "/v2/write/rephrase",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  timeoutMs: TRANSLATE_TIMEOUT_MS,
  params: {
    text: { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 50, description: "Texts to improve" },
    target_lang: langParam("Language of the result, e.g. EN-US, DE (default: the text's language)"),
    writing_style: { in: "body", type: "string", description: "simple, business, academic, casual (prefer_* to fall back)" },
    tone: { in: "body", type: "string", description: "enthusiastic, friendly, confident, diplomatic (prefer_* to fall back)" },
  },
};

const getUsage = { name: "get_usage", title: "Get usage", description: "Characters translated this billing period and the limit", path: "/v2/usage" };

const listLanguages = {
  name: "list_languages",
  title: "List languages",
  description: "Languages DeepL supports as source or target, with supports_formality",
  path: "/v2/languages",
  params: { type: { in: "query", type: "string", enum: ["source", "target"], default: "target", description: "source or target languages" } },
};

const listGlossaries = {
  name: "list_glossaries",
  title: "List glossaries",
  description: "List glossaries with their language-pair dictionaries and entry counts (no entries)",
  path: "/v3/glossaries",
  response: { dataPath: "glossaries" },
};

const getGlossary = { name: "get_glossary", title: "Get glossary", description: "Get a glossary's name and dictionaries", path: "/v3/glossaries/{glossary_id}", params: glossaryIdParam };

const getGlossaryEntries = {
  name: "get_glossary_entries",
  title: "Get glossary entries",
  description: "Get the entries of one dictionary (language pair) of a glossary, as TSV in dictionaries[0].entries",
  path: "/v3/glossaries/{glossary_id}/entries",
  params: {
    ...glossaryIdParam,
    source_lang: { in: "query", type: "string", required: true, description: "Source language of the dictionary, e.g. EN" },
    target_lang: { in: "query", type: "string", required: true, description: "Target language of the dictionary, e.g. DE" },
  },
};

const translateDocument = {
  name: "translate_document",
  title: "Translate document",
  description: "Upload a document (docx, pptx, xlsx, pdf, html, txt, ...) to translate; returns document_id and document_key for get_document_status",
  method: "POST",
  path: "/v2/document",
  write: "unsafe",
  checkHint: "there is no list of documents: upload again only if you got no document_id",
  bodyMode: "multipart",
  multipart: { fileDirEnv: "DEEPL_UPLOAD_DIR", maxFileBytes: 30 * 1024 * 1024 },
  timeoutMs: TRANSLATE_TIMEOUT_MS,
  params: {
    file: { in: "body", type: "string", file: true, required: true, description: "Document to translate (max 30 MB here)" },
    target_lang: langParam("Target language, e.g. EN-US, DE", true),
    source_lang: langParam("Source language (detected when omitted)"),
    output_format: { in: "body", type: "string", description: "Convert the result, e.g. docx for a pdf" },
    formality: { in: "body", type: "string", enum: FORMALITIES, description: "Formal or informal tone" },
    glossary_id: { in: "body", type: "string", description: "Glossary to apply (needs source_lang)" },
  },
};

const getDocumentStatus = {
  name: "get_document_status",
  title: "Get document status",
  description: "Status of a document translation: queued, translating (seconds_remaining), done or error",
  method: "POST",
  path: "/v2/document/{document_id}",
  write: "idempotent",
  params: documentParams,
};

const downloadDocument = {
  name: "download_document",
  title: "Download translated document",
  description: "Save a translated document (status done) into $DEEPL_OUTPUT_DIR; DeepL allows one download",
  method: "POST",
  path: "/v2/document/{document_id}/result",
  write: "unsafe",
  checkHint: "look in DEEPL_OUTPUT_DIR; a document can be downloaded only once",
  timeoutMs: TRANSLATE_TIMEOUT_MS,
  params: documentParams,
  response: { binary: { envDir: "DEEPL_OUTPUT_DIR", maxBytes: 100 * 1024 * 1024 } },
};

export const pluginDefinition = defineRestPlugin({
  name: "deepl",
  version: "0.1.0",
  description: "DeepL API: translate and rephrase text, translate documents, usage, languages and glossaries",
  apiName: "DeepL API",
  extraEnv: ["DEEPL_API_URL"],
  baseUrl: resolveDeeplUrl,
  allowedHostSuffix: ".deepl.com",
  limits: { timeout_ms: 300000 },
  auth: { type: "header", header: "Authorization", prefix: "DeepL-Auth-Key ", env: "DEEPL_API_KEY" },
  // Errors are {"message": "..."}; a wrong key is a 403, 456 means the character quota is used up.
  errors: { messagePath: ["message", "detail"], kindByStatus: { 403: "auth_error", 456: "permission_denied", 529: "rate_limited" } },
  apiRequest: { examplePath: "/v2/usage" },
  operations: [translateText, rephraseText, getUsage, listLanguages, listGlossaries, getGlossary, getGlossaryEntries, translateDocument, getDocumentStatus, downloadDocument],
});
