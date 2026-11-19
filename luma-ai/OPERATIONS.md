# luma-ai operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `luma-ai.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `generate_video` | Text to video or image to video with Ray 3.2 (paid; waits for the generation and saves the MP4) | **prompt**, model, resolution, hdr, duration, loop, start_frame_url, end_frame_url, extend_generation_id, aspect_ratio, user_id, wait |
| `edit_video` | Restyle or edit an existing video (up to 18 s) under a new prompt with Ray 3.2 (paid; waits and saves the MP4) | **prompt**, source_generation_id, source_url, source_media_type, strength, auto_controls, model, resolution, hdr, user_id, wait |
| `reframe_video` | Reframe an existing video to another aspect ratio, generating the new areas (paid per second; waits and saves the MP4) | **aspect_ratio**, prompt, source_generation_id, source_url, source_media_type, model, resolution, user_id, wait |
| `generate_image` | Generate a 2K image with uni-1 or uni-1-max, optionally from reference images (paid; waits and saves the image) | **prompt**, model, image_ref, output_format, aspect_ratio, user_id, wait |
| `get_generation` | State of a generation (queued, processing, completed, failed) with failure_code, usage and fresh output URLs; saves the output of a completed one | **generation_id** |
| `delete_generation` | Request deletion of a finished generation and its outputs; returns a deletion task to poll with get_deletion | **generation_id** |
| `get_deletion` | State of a deletion task (completed means the content was removed) | **task_id** |
| `get_credits` | The team's credit balance (less credits held for running generations) |  |
| `get_usage` | Settled credit spend for the billing period or a window of up to 92 days, optionally grouped | group_by, start, end |
| `api_request` | Call any Luma Agents API endpoint that has no dedicated operation, e.g. path "/credits". Only the API's own host is allowed. | method, **path**, query, body |
