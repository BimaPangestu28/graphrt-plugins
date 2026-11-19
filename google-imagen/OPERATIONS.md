# google-imagen operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-imagen.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_models` | List Gemini API models available to the key (image models have image in their name) | cursor, limit |
| `get_model` | Metadata of one model: version, token limits, supported actions | **model** |
| `generate_image` | Generate an image from a prompt with a Gemini image model (paid, SynthID-watermarked). Saved to $GOOGLE_IMAGEN_OUTPUT_DIR; pass previous_interaction_id to edit the image of an earlier call | **prompt**, model, aspect_ratio, image_size, previous_interaction_id |
| `create_interaction` | Low-level Interactions API call with content blocks (text, base64 or URI images) for image generation or editing (paid). Generated images are saved to $GOOGLE_IMAGEN_OUTPUT_DIR | **input**, model, response_format, previous_interaction_id |
| `get_interaction` | A stored interaction with its steps; images in it are saved to $GOOGLE_IMAGEN_OUTPUT_DIR | **interaction_id** |
| `delete_interaction` | Delete a stored interaction permanently | **interaction_id** |
| `api_request` | Call any Gemini API endpoint that has no dedicated operation, e.g. path "/v1beta/models". Only the API's own host is allowed. | method, **path**, query, body |
| `edit_image` | Edit or combine up to 14 images with a prompt using a Gemini image model (paid). Images: https URLs or files inside $GOOGLE_IMAGEN_UPLOAD_DIR. The result is saved like generate_image | **prompt**, **images**, model, aspect_ratio, image_size |
