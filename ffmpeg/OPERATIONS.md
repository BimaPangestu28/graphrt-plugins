# ffmpeg operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `ffmpeg.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `probe` | Reads a media file's container, duration, size, bit rate and streams (codec, resolution, frame rate, sample rate, channels, language) with ffprobe | **input**, include_raw |
| `transcode` | Converts a video or audio file to another container/codec from a fixed preset menu (mp4, mov, mkv, webm, mp3, m4a, wav, flac, ogg, opus) at low, medium or high quality; writes a new file to FFMPEG_OUTPUT_DIR | **input**, **format**, video_codec, audio_codec, quality, extra_args, output_name |
| `extract_audio` | Writes the first audio track of a video or audio file as mp3, m4a, wav, flac, ogg or opus to FFMPEG_OUTPUT_DIR | **input**, format, quality, output_name |
| `resize` | Scales a video to target_width and/or target_height (the missing side keeps the aspect ratio; with both, the video fits inside the box unless keep_aspect is false) and re-encodes it | **input**, target_width, target_height, keep_aspect, format, quality, output_name |
| `trim` | Cuts a section of a video or audio file between `start` and `end` (or `start` plus `duration`); re-encodes for frame accuracy, or copies streams (fast, cuts at keyframes) with accurate=false | **input**, start, end, duration, accurate, format, quality, output_name |
| `concatenate` | Joins 2-50 video or audio files end to end. By default streams are copied (fast; all files must share codecs and sizes); reencode=true converts to a preset instead | **inputs**, reencode, format, quality, output_name |
| `burn_subtitles` | Renders the cues of a .srt subtitle file (inside FFMPEG_INPUT_DIRS) into the video picture and re-encodes it | **input**, **subtitles**, font_size, format, quality, output_name |
| `thumbnail` | Saves one video frame at a given time as a jpg, png or webp image, optionally scaled to a width | **input**, time, format, target_width, output_name |
| `make_gif` | Turns up to 30 seconds of a video into an animated GIF with a generated palette (frame rate and width are capped) | **input**, start, duration, fps, target_width, output_name |
