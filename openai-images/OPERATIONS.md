# openai-images operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `openai-images.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_models` | List the models this API key can use (image models start with gpt-image, chatgpt-image or dall-e) |  |
| `generate_image` | Generate images from a text prompt (paid). Images are saved to $OPENAI_IMAGES_OUTPUT_DIR; the result lists saved_files | **prompt**, model, n, size, quality, background, output_format, output_compression, moderation, safety_identifier, style, response_format |
| `edit_image` | Edit an image (or create a variation of it) from a prompt, optionally limited to a transparent-mask area (paid). Upload: https URL or a file inside $OPENAI_IMAGES_UPLOAD_DIR | **image**, mask, **prompt**, model, n, size, quality, background, output_format, output_compression, moderation, safety_identifier, input_fidelity |
| `edit_image_from_references` | Edit or combine up to 16 images given as URLs, data URLs or uploaded file ids (GPT Image models, paid). The first image is the one edited | **images**, mask, **prompt**, model, n, size, quality, background, output_format, output_compression, moderation, safety_identifier, input_fidelity |
| `api_request` | Call any OpenAI API endpoint that has no dedicated operation, e.g. path "/models". Only the API's own host is allowed. | method, **path**, query, body |
