# stable-audio operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `stable-audio.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `text_to_audio` | Generate music or sound (up to 190 s) from a prompt with Stable Audio 2.5 or 2 and save it in STABLE_AUDIO_OUTPUT_DIR (paid in credits) | **prompt**, duration, seed, output_format, model, steps, cfg_scale |
| `audio_to_audio` | Transform input audio (https URL or a file inside STABLE_AUDIO_UPLOAD_DIR) with a prompt and save the result in STABLE_AUDIO_OUTPUT_DIR (paid in credits) | **prompt**, **audio**, strength, duration, seed, output_format, model, steps, cfg_scale |
| `inpaint_audio` | Regenerate a time range of input audio (mask_start to mask_end) from a prompt with Stable Audio 2.5 and save the result in STABLE_AUDIO_OUTPUT_DIR (paid in credits) | **prompt**, **audio**, mask_start, mask_end, duration, seed, steps, output_format |
| `text_to_audio_v3` | Generate music or sound (up to 380 s) with Stable Audio 3.0 as a job, wait for it and save it in STABLE_AUDIO_OUTPUT_DIR (paid in credits) | **prompt**, duration, seed, steps, cfg_scale, output_format, wait |
| `get_audio_result` | Fetch a Stable Audio 3 generation by id (kept 24 hours): {status: in-progress}, or the finished audio saved in STABLE_AUDIO_OUTPUT_DIR | **generation_id** |
| `get_balance` | Remaining Stability AI credits (1 credit = $0.01) |  |
| `get_account` | The account behind the key: id, email and organizations |  |
| `api_request` | Call any Stability AI API endpoint that has no dedicated operation, e.g. path "/v1/user/balance". Only the API's own host is allowed. | method, **path**, query, body |
