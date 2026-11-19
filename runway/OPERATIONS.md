# runway operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `runway.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `image_to_video` | Animate an image into a video with a Runway model (paid; waits for the task and saves the video) | model, **prompt_image**, prompt_text, ratio, duration, audio, negative_prompt, output_format, seed, public_figure_threshold, wait |
| `text_to_video` | Generate a video from a text prompt with a Runway model (paid; waits for the task and saves the video) | model, **prompt_text**, ratio, duration, audio, negative_prompt, output_format, seed, public_figure_threshold, wait |
| `video_to_video` | Edit or restyle an input video (up to 30 s) with a prompt, e.g. with aleph2 (paid; waits and saves the video); give video_uri or prompt_video as the model expects | model, video_uri, prompt_video, prompt_text, ratio, keyframes, seed, public_figure_threshold, wait |
| `video_upscale` | Upscale a video (up to 30 s) to 720p–4K, or raise its frame rate (paid; waits and saves the video) | model, **video_uri**, resolution, creativity, target_framerate, wait |
| `text_to_image` | Generate an image from a prompt and optional reference images (paid; waits and saves the image) | model, **prompt_text**, ratio, reference_images, seed, public_figure_threshold, wait |
| `get_task` | Status of a Runway task (PENDING, THROTTLED, RUNNING, SUCCEEDED, FAILED, CANCELLED); saves the output of a finished task | **task_id** |
| `cancel_task` | Cancel a running task, or delete a finished one and its output | **task_id** |
| `get_organization` | Credit balance, tier limits and per-model usage of the API key's organization |  |
| `query_usage` | Credits used per model per day (UTC) between start_date and before_date | start_date, before_date |
| `api_request` | Call any Runway API endpoint that has no dedicated operation, e.g. path "/v1/organization". Only the API's own host is allowed. | method, **path**, query, body |
