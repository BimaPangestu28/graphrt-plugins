# google-veo operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-veo.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `generate_video` | Generate a Veo 3.1 video from text, a first/last frame or a video to extend (paid per second; waits for the operation and saves inline videos) | model, **prompt**, negative_prompt, aspect_ratio, resolution, duration_seconds, generate_audio, sample_count, seed, person_generation, enhance_prompt, compression_quality, resize_mode, storage_uri, image_gcs_uri, image_base64, image_mime_type, last_frame_gcs_uri, video_gcs_uri, wait |
| `get_operation` | State of a Veo operation (done, error, videos as gs:// URIs or inline bytes); saves inline videos of a finished one into GOOGLE_VEO_OUTPUT_DIR | **model**, **operation_name** |
| `api_request` | Call any Vertex AI Veo API endpoint that has no dedicated operation, e.g. path "/publishers/google/models/veo-3.1-generate-001". Only the API's own host is allowed. | method, **path**, query, body |
