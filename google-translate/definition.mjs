/**
 * google-translate plugin definition: Cloud Translation - Basic (v2,
 * https://cloud.google.com/translate/docs/reference/rest/v2/translate) with an API key: translate text, detect the
 * language, list languages. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * Why v2 and an API key: v2 is the only edition that takes a plain API key, which the layer sends as the
 * x-goog-api-key header (never in the URL). v3 (Advanced: glossaries, custom models, documents) needs a project id
 * and an OAuth access token from a service account (JWT bearer grant), which the layer's oauth2 auth does not offer.
 * The v2 surface is these three methods, so the plugin is small on purpose.
 *
 * Retries: translation and detection are billed per character, so they are "unsafe": a 5xx or timeout is when Google
 * may already have billed them, so they are never retried and the error says how to check (429 is still retried).
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";

const PAID_CHECK_HINT = "the characters may have been billed; check the API's usage in the Cloud console before retrying";
const textsParam = { in: "body", type: "array", items: { type: "string" }, required: true, maxItems: 128, wireName: "q", description: "Texts (at most 128 per call, 30k characters recommended)" };

const translateText = {
  name: "translate_text",
  title: "Translate text",
  description: "Translate texts into one language; [i].translatedText belongs to text[i], with detectedSourceLanguage when source is omitted",
  method: "POST",
  path: "/language/translate/v2",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  params: {
    text: textsParam,
    target: { in: "body", type: "string", required: true, description: "Target language (ISO-639 code), e.g. en, id, zh-CN" },
    source: { in: "body", type: "string", description: "Source language (detected when omitted)" },
    format: { in: "body", type: "string", enum: ["text", "html"], default: "text", description: "text, or html to keep markup (and escape entities)" },
    model: { in: "body", type: "string", enum: ["nmt", "base"], description: "Translation model (default nmt)" },
  },
  response: { dataPath: "data.translations" },
};

const detectLanguage = {
  name: "detect_language",
  title: "Detect language",
  description: "Detect the language of texts; [i] lists {language, confidence} candidates for text[i]",
  method: "POST",
  path: "/language/translate/v2/detect",
  write: "unsafe",
  checkHint: PAID_CHECK_HINT,
  params: { text: textsParam },
  response: { dataPath: "data.detections" },
};

const listLanguages = {
  name: "list_languages",
  title: "List languages",
  description: "Languages Google Translate supports, with names in the display language",
  path: "/language/translate/v2/languages",
  params: {
    display_language: { in: "query", type: "string", default: "en", wireName: "target", description: "Language for the names, e.g. en" },
    model: { in: "query", type: "string", enum: ["nmt", "base"], description: "Only languages of this model" },
  },
  response: { dataPath: "data.languages" },
};

export const pluginDefinition = defineRestPlugin({
  name: "google-translate",
  version: "0.1.0",
  description: "Google Cloud Translation (Basic, v2) with an API key: translate text, detect language, list languages",
  apiName: "Cloud Translation API (v2)",
  baseUrl: "https://translation.googleapis.com",
  auth: { type: "header", header: "x-goog-api-key", env: "GOOGLE_TRANSLATE_API_KEY" },
  // Google errors: {"error": {"code", "message", "status", "details": [{"reason": "API_KEY_INVALID"}]}}; an invalid key
  // is a 400, so the ErrorInfo reason decides the kind.
  errors: {
    messagePath: "error.message",
    codePath: "error.details.0.reason",
    kindByCode: {
      API_KEY_INVALID: "auth_error",
      API_KEY_EXPIRED: "auth_error",
      API_KEY_SERVICE_BLOCKED: "permission_denied",
      SERVICE_DISABLED: "permission_denied",
      BILLING_DISABLED: "permission_denied",
      RATE_LIMIT_EXCEEDED: "rate_limited",
    },
  },
  apiRequest: { examplePath: "/language/translate/v2/languages" },
  operations: [translateText, detectLanguage, listLanguages],
});
