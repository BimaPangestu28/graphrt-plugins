# meeting-notes operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `meeting-notes.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
**Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `detect` | Lists the programs using the microphone that could be a meeting (Zoom, Teams, a browser…), and the recording in progress |  |
| `wait_for_meeting` | Watches the microphone until a meeting app has used it for confirm_seconds, then returns one event (the meeting_detected trigger); each meeting is reported once, never while recording; returns no event after timeout_seconds (at most 280) | cursor, timeout_seconds, confirm_seconds, release_seconds, poll_interval_ms |
| `start_recording` | Records the microphone (You) and the computer's sound (Others) as two tracks until stop_recording, or until no meeting app has used the microphone for MEETING_NOTES_AUTO_STOP_SECONDS; runs on its own, so the step returns at once | meeting_app, meeting_title |
| `recording_status` | The meeting being recorded, if any |  |
| `stop_recording` | Stops the recording (the one in progress, or meeting_id) and waits until its files are complete | meeting_id |
| `wait_for_recording_end` | Returns the meetings whose recording ended since the cursor (the meeting_recorded trigger), waiting up to timeout_seconds (at most 280) for one | cursor, timeout_seconds, poll_interval_ms |
| `transcribe` | Transcribes a recorded meeting on this computer with whisper.cpp (downloaded the first time, about 150 MB): the microphone as "You", the computer's sound as "Others", silence skipped; deletes the audio afterwards unless keep_audio. A meeting already transcribed returns its transcript | **meeting_id**, language, keep_audio |

## Triggers

Events a host such as graphrt Desktop starts workflows on: it long-polls the watch node outside any run and starts one run per event, with the event's fields as inputs.

| Trigger | Title | Watch node | Description | Event fields |
|---------|-------|------------|-------------|--------------|
| `meeting_detected` | When a meeting is detected | `meeting-notes.wait_for_meeting` | A meeting app (Zoom, Teams, Meet in a browser…) uses the microphone. Ask before recording: a human-input step, then start_recording. | `meeting_app`, `message`, `consent_reminder`, `detected_at` |
| `meeting_recorded` | When a meeting is recorded | `meeting-notes.wait_for_recording_end` | A recording stopped (by stop_recording or because the meeting ended). Transcribe it, then summarize and send. | `meeting_id`, `meeting_title`, `meeting_app`, `started_at`, `ended_at`, `duration_minutes`, `stop_reason` |
