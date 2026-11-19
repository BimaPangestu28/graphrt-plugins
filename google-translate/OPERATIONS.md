# google-translate operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-translate.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `translate_text` | Translate texts into one language; [i].translatedText belongs to text[i], with detectedSourceLanguage when source is omitted | **text**, **target**, source, format, model |
| `detect_language` | Detect the language of texts; [i] lists {language, confidence} candidates for text[i] | **text** |
| `list_languages` | Languages Google Translate supports, with names in the display language | display_language, model |
| `api_request` | Call any Cloud Translation API (v2) endpoint that has no dedicated operation, e.g. path "/language/translate/v2/languages". Only the API's own host is allowed. | method, **path**, query, body |
