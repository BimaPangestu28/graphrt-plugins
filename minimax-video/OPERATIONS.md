# minimax-video operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `minimax-video.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `generate_video` | Text, image (first/last frame) or reference to video with MiniMax-H3 models (paid per second; waits and saves the video) | model, **content**, resolution, duration, ratio, generate_audio, prompt_expansion_mode, wait |
| `generate_video_with_callback` | Text, image (first/last frame) or reference to video with MiniMax-H3 models (paid per second; waits and saves the video); MiniMax also POSTs status changes to callback_url (it must echo the challenge first) | model, **content**, resolution, duration, ratio, generate_audio, prompt_expansion_mode, **callback_url**, wait |
| `get_task` | Status (queued, running, succeeded, failed, cancelled), error, usage and video URL of a V2 task from the last 7 days; saves the video of a succeeded task | **task_id** |
| `list_tasks` | V2 tasks from the last 7 days, newest first, filtered by status, model or task type | status, model, cursor, limit |
| `delete_task` | Cancel a queued V2 task, or delete a finished task's record and video | **task_id** |
| `generate_hailuo_video` | Text, image or first+last frame to video with Hailuo 2.3 / 02 (paid per video; waits and returns the file_id for retrieve_file) | model, prompt, first_frame_image, last_frame_image, duration, resolution, prompt_optimizer, fast_pretreatment, wait |
| `generate_hailuo_video_with_callback` | Text, image or first+last frame to video with Hailuo 2.3 / 02 (paid per video; waits and returns the file_id for retrieve_file); MiniMax also POSTs status changes to callback_url (it must echo the challenge first) | model, prompt, first_frame_image, last_frame_image, duration, resolution, prompt_optimizer, fast_pretreatment, **callback_url**, wait |
| `get_hailuo_task` | Status (Preparing, Queueing, Processing, Success, Fail) and file_id of a V1 Hailuo task | **task_id** |
| `retrieve_file` | Download URL (valid about 1 hour) and details of a generated file, e.g. a Hailuo video's file_id; saves the file | **file_id** |
| `api_request` | Call any MiniMax API endpoint that has no dedicated operation, e.g. path "/v2/query/video_generation". Only the API's own host is allowed. | method, **path**, query, body |
