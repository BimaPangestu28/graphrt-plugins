# ideogram operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `ideogram.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `generate_image` | Generate images with Ideogram 4.5 (strong typography and prompt fidelity), or edit a source image by prompt ($0.03-0.22 per image by quality). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **prompt**, image, mask, size, quality, background, magic_prompt, seed, num_images, enable_copyright_detection |
| `generate_image_v3` | Generate images with Ideogram 3.0, with style types, presets, style codes and a style reference ($0.03 turbo, $0.06 default, $0.09 quality per image). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **prompt**, negative_prompt, aspect_ratio, resolution, rendering_speed, magic_prompt, style_type, style_preset, style_codes, style_reference_image, seed, num_images, enable_copyright_detection |
| `remix_image` | Transform an image with a prompt (Ideogram 3.0, billed at the 3.0 generation rate). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **prompt**, **image**, image_weight, negative_prompt, aspect_ratio, resolution, rendering_speed, magic_prompt, style_type, style_preset, style_codes, style_reference_image, seed, num_images, enable_copyright_detection |
| `precise_edit` | Change only what the prompt says and copy every other pixel exactly, optionally limited by a mask ($0.008-0.22 per image by quality). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **prompt**, **image**, mask, reference_image, quality, context_window, seed, num_images, enable_copyright_detection |
| `inpaint_image` | Repaint the black area of a mask with new content (Ideogram 3.0, billed at the 3.0 generation rate). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **prompt**, **image**, **mask**, rendering_speed, magic_prompt, style_type, style_preset, style_codes, seed, num_images, enable_copyright_detection |
| `reframe_image` | Extend an image to a new resolution/aspect ratio, filling the new area (billed at the 3.0 generation rate). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **image**, **resolution**, rendering_speed, style_preset, seed, num_images |
| `upscale_image` | Upscale an image 2x, 4x or 8x with the model Ideogram picks (priced by the chosen model; use dry_run for a quote). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **image**, upscale_factor, seed |
| `remove_background` | Cut out the foreground with a transparent background ($0.01). Images are saved to $IDEOGRAM_OUTPUT_DIR | dry_run, **image**, private |
| `describe_image` | Turn an image into a structured Ideogram 4.0 JSON prompt (subjects, text, layout) to regenerate or edit it ($0.01) | **image**, include_bbox, include_style_descriptions, include_tags |
| `get_generation` | Status (pending, completed, failed) and images of a generation by generation_id; completed image URLs are saved to $IDEOGRAM_OUTPUT_DIR | **generation_id** |
| `get_usage` | Usage and spend of the API account in daily or hourly buckets | **start_time**, end_time, bucket_width, sources |
| `api_request` | Call any Ideogram API endpoint that has no dedicated operation, e.g. path "/v2/account/usage?start_time=2026-11-01T00:00:00Z". Only the API's own host is allowed. | method, **path**, query, body |
