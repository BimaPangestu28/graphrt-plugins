/**
 * Meetings on disk: one folder per meeting under the meetings directory, with `meta.json`, the tracks (`mic.wav`,
 * `system.wav`) and, once transcribed, `transcript.json` and `transcript.md`.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pluginError } from "./errors.mjs";

export const TRACKS = [{ track: "mic", file: "mic.wav" }, { track: "system", file: "system.wav" }];
const MEETING_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const META_FILE = "meta.json";
export const STOP_REQUEST_FILE = "stop.request";

/** Whether `id` has the shape of a meeting id (it never leaves the meetings directory). */
export const isMeetingId = (id) => typeof id === "string" && MEETING_ID.test(id);

function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * @param date - When the meeting started (Date)
 * @returns `YYYYMMDD-HHMMSS-<6 hex>` in UTC (string)
 */
export function newMeetingId(date) {
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * "Zoom meeting, 26 Nov 14:05" in the computer's time zone.
 *
 * @param app - Program name or null (string|null)
 * @param date - Start (Date)
 * @returns Title (string)
 */
export function defaultTitle(app, date) {
  const when = date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
  return app ? `${app} meeting, ${when}` : `Meeting, ${when}`;
}

export function meetingFolder(meetingsDirectory, id) {
  if (!isMeetingId(id)) throw pluginError("invalid_input", "`meeting_id` is not a meeting id");
  return join(meetingsDirectory, id);
}

/**
 * @returns The meeting's meta.json, or null when the folder has none (Promise<object|null>)
 */
export async function readMeeting(meetingsDirectory, id) {
  try {
    return JSON.parse(await fs.readFile(join(meetingFolder(meetingsDirectory, id), META_FILE), "utf8"));
  } catch (readError) {
    if (readError.code === "ENOENT") return null;
    throw readError;
  }
}

/** Writes meta.json atomically (temporary file, then rename). */
export async function writeMeeting(meetingsDirectory, meeting) {
  const folder = meetingFolder(meetingsDirectory, meeting.id);
  await fs.mkdir(folder, { recursive: true });
  const temporary = join(folder, `${META_FILE}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(meeting, null, 2)}\n`);
  await fs.rename(temporary, join(folder, META_FILE));
}

/** Every meeting, oldest first; folders without a readable meta.json are skipped. */
export async function listMeetings(meetingsDirectory) {
  let entries;
  try {
    entries = await fs.readdir(meetingsDirectory, { withFileTypes: true });
  } catch (listError) {
    if (listError.code === "ENOENT") return [];
    throw listError;
  }
  const meetings = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isMeetingId(entry.name)) continue;
    try {
      const meeting = await readMeeting(meetingsDirectory, entry.name);
      if (meeting) meetings.push(meeting);
    } catch {
      // A damaged meta.json is skipped, not fatal for the list.
    }
  }
  return meetings.sort((left, right) => left.started_at.localeCompare(right.started_at));
}

/** Whether a process exists. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (signalError) {
    return signalError.code === "EPERM";
  }
}

/**
 * The meeting being recorded, after marking recordings whose supervisor is gone (computer restarted, killed) as
 * recorded.
 *
 * @param meetingsDirectory - Meetings directory (string)
 * @param now - Current time (Date)
 * @returns The active meeting or null (Promise<object|null>)
 */
export async function activeRecording(meetingsDirectory, now) {
  let active = null;
  for (const meeting of await listMeetings(meetingsDirectory)) {
    if (meeting.status !== "recording") continue;
    if (isAlive(meeting.supervisor_pid)) {
      active = meeting;
      continue;
    }
    await writeMeeting(meetingsDirectory, { ...meeting, status: "recorded", ended_at: meeting.ended_at ?? now.toISOString(), stop_reason: "interrupted" });
  }
  return active;
}

/** Removes the audio tracks of a meeting, keeping its transcript and meta.json. */
export async function deleteAudio(meetingsDirectory, id) {
  const folder = meetingFolder(meetingsDirectory, id);
  for (const { file } of TRACKS) await fs.rm(join(folder, file), { force: true });
}

/** What a run gets about a meeting. */
export function describeMeeting(meeting) {
  const endedAt = meeting.ended_at ? Date.parse(meeting.ended_at) : null;
  const durationMinutes = endedAt ? Math.max(0, Math.round((endedAt - Date.parse(meeting.started_at)) / 60000)) : null;
  return {
    meeting_id: meeting.id,
    meeting_title: meeting.title,
    meeting_app: meeting.app ?? "",
    started_at: meeting.started_at,
    ended_at: meeting.ended_at ?? "",
    duration_minutes: durationMinutes,
    status: meeting.status,
    stop_reason: meeting.stop_reason ?? "",
  };
}
