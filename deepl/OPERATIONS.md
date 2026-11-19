# deepl operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `deepl.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `translate_text` | Translate up to 50 texts into one language; translations[i].text belongs to text[i], with detected_source_language | **text**, **target_lang**, source_lang, context, formality, model_type, glossary_id, preserve_formatting, split_sentences, tag_handling, custom_instructions, show_billed_characters |
| `rephrase_text` | Improve or restyle texts with DeepL Write (Pro plans); improvements[i].text belongs to text[i] | **text**, target_lang, writing_style, tone |
| `get_usage` | Characters translated this billing period and the limit |  |
| `list_languages` | Languages DeepL supports as source or target, with supports_formality | type |
| `list_glossaries` | List glossaries with their language-pair dictionaries and entry counts (no entries) |  |
| `get_glossary` | Get a glossary's name and dictionaries | **glossary_id** |
| `get_glossary_entries` | Get the entries of one dictionary (language pair) of a glossary, as TSV in dictionaries[0].entries | **glossary_id**, **source_lang**, **target_lang** |
| `translate_document` | Upload a document (docx, pptx, xlsx, pdf, html, txt, ...) to translate; returns document_id and document_key for get_document_status | **file**, **target_lang**, source_lang, output_format, formality, glossary_id |
| `get_document_status` | Status of a document translation: queued, translating (seconds_remaining), done or error | **document_id**, **document_key** |
| `download_document` | Save a translated document (status done) into $DEEPL_OUTPUT_DIR; DeepL allows one download | **document_id**, **document_key** |
| `api_request` | Call any DeepL API endpoint that has no dedicated operation, e.g. path "/v2/usage". Only the API's own host is allowed. | method, **path**, query, body |
