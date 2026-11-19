# stability-ai operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `stability-ai.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_account` | The account (email, id, organizations) that owns the API key |  |
| `get_balance` | Credit balance of the key's account or organization (1 credit = $0.01) |  |
| `generate_ultra` | Highest-quality text-to-image (about 1 megapixel), optionally guided by an input image (8 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **prompt**, negative_prompt, aspect_ratio, seed, output_format, style_preset, image, strength |
| `generate_core` | Fast, low-cost text-to-image (3 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **prompt**, negative_prompt, aspect_ratio, seed, style_preset, output_format |
| `generate_sd3` | Text-to-image or image-to-image with Stable Diffusion 3.5 Large (6.5 credits), Large Turbo (4) or Medium (3.5) (3.5-6.5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **prompt**, model, mode, image, strength, aspect_ratio, negative_prompt, cfg_scale, seed, style_preset, output_format |
| `upscale_fast` | Upscale an image 4x in about a second (output up to 4 megapixels) (2 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, output_format |
| `upscale_conservative` | Upscale an image (64x64 to 1 megapixel) to 4 megapixels with minimal changes (40 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, **prompt**, negative_prompt, creativity, seed, output_format |
| `upscale_creative` | Re-imagine and upscale a degraded image (under 1 megapixel) to up to 4K, waiting for the async job (60 credits). The image is saved to $STABILITY_AI_OUTPUT_DIR | **image**, **prompt**, negative_prompt, creativity, style_preset, seed, output_format, wait |
| `get_result` | Fetch an async generation by id (results are kept 24 hours): {id, status: "in-progress"} while running, else the image saved to $STABILITY_AI_OUTPUT_DIR with seed and finish_reason | **generation_id** |
| `erase_object` | Remove unwanted objects marked by a mask (or the image's alpha channel) (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, mask, grow_mask, seed, output_format |
| `inpaint` | Fill or replace the masked area (or transparent area) of an image with new content from a prompt (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, **prompt**, mask, negative_prompt, grow_mask, seed, style_preset, output_format |
| `outpaint` | Extend an image in any direction (left/right/up/down pixels, at least one) (4 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, left, right, up, down, creativity, prompt, seed, style_preset, output_format |
| `search_and_replace` | Find an object by a short description and replace it with the prompt, no mask needed (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, **prompt**, **search_prompt**, negative_prompt, grow_mask, seed, style_preset, output_format |
| `search_and_recolor` | Find an object by a short description and recolor it as the prompt says, no mask needed (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, **prompt**, **select_prompt**, negative_prompt, grow_mask, seed, style_preset, output_format |
| `remove_background` | Cut the foreground out of an image with a transparent background (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **image**, output_format |
| `control_sketch` | Turn a sketch or line art into a finished image that follows its contours (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **prompt**, **image**, control_strength, negative_prompt, seed, style_preset, output_format |
| `control_structure` | Generate an image that keeps the structure (layout, poses) of an input image (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **prompt**, **image**, control_strength, negative_prompt, seed, style_preset, output_format |
| `control_style` | Generate an image from a prompt in the style of an input image (5 credits). Saved to $STABILITY_AI_OUTPUT_DIR; returns {path, bytes, content_type} | **prompt**, **image**, negative_prompt, aspect_ratio, fidelity, seed, style_preset, output_format |
| `api_request` | Call any Stability AI REST API endpoint that has no dedicated operation, e.g. path "/v1/user/balance". Only the API's own host is allowed. | method, **path**, query, body |
