# kling operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `kling.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `text_to_video` | Generate a video from a prompt with a Kling model (paid per second; waits for the task and saves the video) | **model**, **prompt**, aspect_ratio, multi_shot, resolution, duration, audio, external_task_id, watermark, wait |
| `image_to_video` | Animate first/middle/last frame images with a prompt (paid per second; waits and saves the video) | **model**, **contents**, resolution, duration, audio, external_task_id, watermark, wait |
| `omni_video` | Generate a video from a prompt plus reference images, videos or elements (paid per second; waits and saves the video) | **model**, **contents**, aspect_ratio, resolution, duration, audio, external_task_id, watermark, wait |
| `text_to_video_with_callback` | Generate a video from a prompt with a Kling model (paid per second; waits for the task and saves the video); Kling also notifies callback_url on status changes | **model**, **prompt**, aspect_ratio, multi_shot, resolution, duration, audio, external_task_id, watermark, **callback_url**, wait |
| `image_to_video_with_callback` | Animate first/middle/last frame images with a prompt (paid per second; waits and saves the video); Kling also notifies callback_url on status changes | **model**, **contents**, resolution, duration, audio, external_task_id, watermark, **callback_url**, wait |
| `omni_video_with_callback` | Generate a video from a prompt plus reference images, videos or elements (paid per second; waits and saves the video); Kling also notifies callback_url on status changes | **model**, **contents**, aspect_ratio, resolution, duration, audio, external_task_id, watermark, **callback_url**, wait |
| `get_tasks` | Status (submitted, processing, succeeded, failed), outputs, usage and billing of tasks by id; saves the outputs of finished ones | task_ids, external_task_ids |
| `list_tasks` | Tasks created in a time window (default the last 30 days), optionally filtered by status or product type | start_time, end_time, filters, cursor, limit |
| `get_account_costs` | Resource packages bought in a time window with their remaining quantity (free to call; at most 1 call per second) | **start_time**, **end_time**, resource_pack_name |
| `api_request` | Call any Kling AI API endpoint that has no dedicated operation, e.g. path "/tasks". Only the API's own host is allowed. | method, **path**, query, body |
