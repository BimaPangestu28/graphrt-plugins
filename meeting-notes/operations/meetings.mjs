/**
 * detect, wait_for_meeting, start_recording, recording_status, stop_recording, wait_for_recording_end, transcribe.
 *
 * Nothing records on its own: wait_for_meeting only reports that a meeting started (the `meeting_detected` trigger),
 * and a workflow asks the user (a human-input step) before calling start_recording.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describeMicUsers, meetingApps } from "../lib/apps.mjs";
import { decodeCursor, encodeCursor, isMeetingWatchState, isRecordingWatchState } from "../lib/cursor.mjs";
import { INITIAL_STATE, observe } from "../lib/detector.mjs";
import { invalidInput, pluginError } from "../lib/errors.mjs";
import { LANGUAGE_PATTERN } from "../lib/settings.mjs";
import {
  activeRecording, defaultTitle, deleteAudio, describeMeeting, listMeetings, meetingFolder, newMeetingId, readMeeting,
  STOP_REQUEST_FILE, TRACKS, writeMeeting,
} from "../lib/store.mjs";
import { mergeTracks, renderTranscript } from "../lib/transcript.mjs";
import { keepVoicedSegments, MIN_SPEECH_MS, parseWav, speechMs, voicedRanges } from "../lib/vad.mjs";
import { ensureWhisper, transcribeFile } from "../lib/whisper.mjs";

export const MAX_WAIT_SECONDS = 280;
export const CONSENT_REMINDER = "Let the others know you are taking notes.";
const VAD_SLACK_MS = 500;
const STOP_WAIT_MS = 15000;

const TIMEOUT_PARAMETER = { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, default: 240, description: `Longest wait in seconds (at most ${MAX_WAIT_SECONDS})` };
const POLL_PARAMETER = { type: "integer", minimum: 1000, maximum: 60000, default: 3000, description: "Time between microphone checks" };
const MEETING_ID_PARAMETER = { type: "string", description: "Meeting id from start_recording or the meeting_recorded trigger" };

async function micApps(client, signal) {
  return meetingApps(await client.listMicUsers(signal));
}

const detectOperation = {
  name: "detect",
  title: "Who uses the microphone",
  description: "Lists the programs using the microphone that could be a meeting (Zoom, Teams, a browser…), and the recording in progress",
  parameters: { type: "object", properties: {} },
  run: async ({ client, signal }) => {
    const apps = await micApps(client, signal);
    const recording = await activeRecording(client.settings.meetingsDirectory, new Date(client.now()));
    return { data: { in_use: apps.length > 0, apps, message: describeMicUsers(apps), recording: recording ? describeMeeting(recording) : null } };
  },
};

const waitForMeetingOperation = {
  name: "wait_for_meeting",
  title: "Wait for a meeting",
  description: `Watches the microphone until a meeting app has used it for confirm_seconds, then returns one event (the meeting_detected trigger); each meeting is reported once, never while recording; returns no event after timeout_seconds (at most ${MAX_WAIT_SECONDS})`,
  nodeOnly: true,
  parameters: {
    type: "object",
    properties: {
      cursor: { type: "string", description: "Cursor from the previous call; without it the watch starts now" },
      timeout_seconds: TIMEOUT_PARAMETER,
      confirm_seconds: { type: "integer", minimum: 1, maximum: 120, default: 5, description: "How long a meeting app must use the microphone" },
      release_seconds: { type: "integer", minimum: 5, maximum: 600, default: 15, description: "How long the microphone must be free before the next meeting is reported" },
      poll_interval_ms: POLL_PARAMETER,
    },
  },
  run: async ({ client, args, signal }) => {
    let state = args.cursor ? decodeCursor(args.cursor, isMeetingWatchState) : { ...INITIAL_STATE };
    const timing = { confirmMs: args.confirm_seconds * 1000, releaseMs: args.release_seconds * 1000 };
    const startedAt = client.now();
    for (;;) {
      const now = client.now();
      const apps = await micApps(client, signal);
      const isRecording = Boolean(await activeRecording(client.settings.meetingsDirectory, new Date(now)));
      const step = observe(state, { now, inUse: apps.length > 0, isRecording }, timing);
      state = step.state;
      if (step.detected) {
        const event = {
          meeting_app: apps[0].label,
          message: describeMicUsers(apps),
          consent_reminder: CONSENT_REMINDER,
          detected_at: new Date(now).toISOString(),
          apps,
        };
        return { data: { events: [event], cursor: encodeCursor(state) } };
      }
      const remainingMs = args.timeout_seconds * 1000 - (client.now() - startedAt);
      if (remainingMs <= 0) return { data: { events: [], cursor: encodeCursor(state) } };
      await client.sleep(Math.min(args.poll_interval_ms, remainingMs), signal);
    }
  },
};

const startRecordingOperation = {
  name: "start_recording",
  title: "Start recording a meeting",
  description: "Records the microphone (You) and the computer's sound (Others) as two tracks until stop_recording, or until no meeting app has used the microphone for MEETING_NOTES_AUTO_STOP_SECONDS; runs on its own, so the step returns at once",
  nodeOnly: true,
  parameters: {
    type: "object",
    properties: {
      meeting_app: { type: "string", description: "The program of the meeting, e.g. from the meeting_detected trigger" },
      meeting_title: { type: "string", description: "Title; default \"<app> meeting, <date time>\"" },
    },
  },
  run: async ({ client, args }) => {
    const { meetingsDirectory, autoStopSeconds } = client.settings;
    const now = new Date(client.now());
    const active = await activeRecording(meetingsDirectory, now);
    if (active) throw pluginError("invalid_input", `Already recording ${active.title} (${active.id}); stop it first`);
    const app = args.meeting_app?.trim() || null;
    const id = newMeetingId(now);
    const folder = meetingFolder(meetingsDirectory, id);
    await fs.mkdir(folder, { recursive: true });
    const meeting = {
      id,
      title: args.meeting_title?.trim() || defaultTitle(app, now),
      app,
      started_at: now.toISOString(),
      ended_at: null,
      status: "recording",
      tracks: TRACKS.map(({ track, file }) => ({ track, file })),
      audio_deleted: false,
    };
    await writeMeeting(meetingsDirectory, meeting);
    const supervisorPid = client.startSupervisor({ folder, meetingsDirectory, meetingId: id, autoStopSeconds });
    await writeMeeting(meetingsDirectory, { ...meeting, supervisor_pid: supervisorPid });
    return { data: { ...describeMeeting(meeting), folder } };
  },
};

const recordingStatusOperation = {
  name: "recording_status",
  title: "Recording status",
  description: "The meeting being recorded, if any",
  parameters: { type: "object", properties: {} },
  run: async ({ client }) => {
    const active = await activeRecording(client.settings.meetingsDirectory, new Date(client.now()));
    return { data: { recording: active ? describeMeeting(active) : null } };
  },
};

const stopRecordingOperation = {
  name: "stop_recording",
  title: "Stop recording",
  description: "Stops the recording (the one in progress, or meeting_id) and waits until its files are complete",
  nodeOnly: true,
  parameters: { type: "object", properties: { meeting_id: MEETING_ID_PARAMETER } },
  run: async ({ client, args, signal }) => {
    const { meetingsDirectory } = client.settings;
    const active = await activeRecording(meetingsDirectory, new Date(client.now()));
    const id = args.meeting_id?.trim() || active?.id;
    if (!id) throw pluginError("not_found", "No meeting is being recorded");
    const meeting = await readMeeting(meetingsDirectory, id);
    if (!meeting) throw pluginError("not_found", `Meeting ${id} not found`);
    if (meeting.status === "recording") {
      await fs.writeFile(join(meetingFolder(meetingsDirectory, id), STOP_REQUEST_FILE), new Date(client.now()).toISOString());
      const deadline = client.now() + STOP_WAIT_MS;
      for (;;) {
        const current = await readMeeting(meetingsDirectory, id);
        if (current?.status !== "recording") return { data: describeMeeting(current) };
        if (client.now() >= deadline) throw pluginError("api_error", `Meeting ${id} did not stop within ${STOP_WAIT_MS / 1000} s`, { retryable: true });
        await client.sleep(500, signal);
      }
    }
    return { data: describeMeeting(meeting) };
  },
};

const waitForRecordingEndOperation = {
  name: "wait_for_recording_end",
  title: "Wait for a recorded meeting",
  description: `Returns the meetings whose recording ended since the cursor (the meeting_recorded trigger), waiting up to timeout_seconds (at most ${MAX_WAIT_SECONDS}) for one`,
  nodeOnly: true,
  parameters: {
    type: "object",
    properties: {
      cursor: { type: "string", description: "Cursor from the previous call; without it, only meetings ending from now on count" },
      timeout_seconds: TIMEOUT_PARAMETER,
      poll_interval_ms: POLL_PARAMETER,
    },
  },
  run: async ({ client, args, signal }) => {
    const since = args.cursor ? decodeCursor(args.cursor, isRecordingWatchState).since : new Date(client.now()).toISOString();
    const startedAt = client.now();
    for (;;) {
      await activeRecording(client.settings.meetingsDirectory, new Date(client.now()));
      const ended = (await listMeetings(client.settings.meetingsDirectory))
        .filter((meeting) => meeting.status !== "recording" && meeting.ended_at && meeting.ended_at > since)
        .sort((left, right) => left.ended_at.localeCompare(right.ended_at));
      if (ended.length > 0) {
        return { data: { events: ended.map(describeMeeting), cursor: encodeCursor({ since: ended.at(-1).ended_at }) } };
      }
      const remainingMs = args.timeout_seconds * 1000 - (client.now() - startedAt);
      if (remainingMs <= 0) return { data: { events: [], cursor: encodeCursor({ since }) } };
      await client.sleep(Math.min(args.poll_interval_ms, remainingMs), signal);
    }
  },
};

async function transcribeMeeting(client, meeting, { language, keepAudio, signal }) {
  const { meetingsDirectory } = client.settings;
  const folder = meetingFolder(meetingsDirectory, meeting.id);
  if (meeting.audio_deleted) throw pluginError("not_found", `The audio of meeting ${meeting.id} was deleted after an earlier transcript`);
  await writeMeeting(meetingsDirectory, { ...meeting, status: "transcribing", error: null });
  try {
    let whisper = null;
    const tracks = [];
    for (const { track, file } of TRACKS) {
      const audio = join(folder, file);
      let ranges;
      try {
        const pcm = parseWav(await fs.readFile(audio));
        ranges = voicedRanges(pcm);
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      if (speechMs(ranges) < MIN_SPEECH_MS) {
        tracks.push({ track, segments: [] });
        continue;
      }
      whisper ??= await client.ensureWhisper(signal);
      const segments = await client.transcribeFile({ ...whisper, audio, language, signal });
      tracks.push({ track, segments: keepVoicedSegments(segments, ranges, VAD_SLACK_MS) });
    }
    if (tracks.length === 0) throw pluginError("not_found", `Meeting ${meeting.id} has no recorded tracks`);
    const lines = mergeTracks(tracks);
    const text = renderTranscript(meeting.title, lines);
    await fs.writeFile(join(folder, "transcript.json"), `${JSON.stringify(lines, null, 2)}\n`);
    await fs.writeFile(join(folder, "transcript.md"), text);
    if (!keepAudio) await deleteAudio(meetingsDirectory, meeting.id);
    await writeMeeting(meetingsDirectory, { ...meeting, status: "transcribed", error: null, audio_deleted: !keepAudio });
    return { text, lines };
  } catch (transcribeError) {
    await writeMeeting(meetingsDirectory, { ...meeting, status: "failed", error: transcribeError.message });
    throw transcribeError;
  }
}

const inFlight = new Map();

const transcribeOperation = {
  name: "transcribe",
  title: "Transcribe a meeting",
  description: "Transcribes a recorded meeting on this computer with whisper.cpp (downloaded the first time, about 150 MB): the microphone as \"You\", the computer's sound as \"Others\", silence skipped; deletes the audio afterwards unless keep_audio. A meeting already transcribed returns its transcript",
  nodeOnly: true,
  parameters: {
    type: "object",
    properties: {
      meeting_id: MEETING_ID_PARAMETER,
      language: { type: "string", description: "auto, or a language code such as en or id (default MEETING_NOTES_LANGUAGE, else auto)" },
      keep_audio: { type: "boolean", default: false, description: "Keep the recorded audio after the transcript is made" },
    },
    required: ["meeting_id"],
  },
  run: async ({ client, args, signal }) => {
    const { meetingsDirectory } = client.settings;
    const id = args.meeting_id.trim();
    const language = (args.language?.trim().toLowerCase() || client.settings.language);
    if (!LANGUAGE_PATTERN.test(language)) throw invalidInput("`language` must be auto or a language code such as en or id");
    if (inFlight.has(id)) await inFlight.get(id).catch(() => {});
    const meeting = await readMeeting(meetingsDirectory, id);
    if (!meeting) throw pluginError("not_found", `Meeting ${id} not found`);
    if (meeting.status === "recording") throw invalidInput(`Meeting ${id} is still being recorded; stop it first`);
    const folder = meetingFolder(meetingsDirectory, id);
    if (meeting.status === "transcribed") {
      const lines = JSON.parse(await fs.readFile(join(folder, "transcript.json"), "utf8"));
      const text = await fs.readFile(join(folder, "transcript.md"), "utf8");
      return { data: { ...describeMeeting(meeting), text, lines } };
    }
    const work = transcribeMeeting(client, meeting, { language, keepAudio: args.keep_audio, signal });
    inFlight.set(id, work);
    try {
      const { text, lines } = await work;
      return { data: { ...describeMeeting({ ...meeting, status: "transcribed" }), text, lines } };
    } finally {
      inFlight.delete(id);
    }
  },
};

export const meetingOperations = [
  detectOperation, waitForMeetingOperation, startRecordingOperation, recordingStatusOperation, stopRecordingOperation,
  waitForRecordingEndOperation, transcribeOperation,
];
