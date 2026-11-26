/**
 * meeting-notes plugin definition: notice a meeting on this computer (another app using the microphone), record the
 * microphone and the computer's sound as two tracks, and transcribe them locally with whisper.cpp.
 *
 * Linux (PipeWire) for now. No bot joins the call and no meeting API is used. It never records on its own: the
 * `meeting_detected` trigger only reports a meeting, and the workflow asks the user before `start_recording`.
 * Two triggers let a host such as graphrt Desktop start workflows without polling on a schedule.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { availableParallelism } from "node:os";
import { downloadPublicHttpsToFile } from "./lib/shared/public-https-fetch.mjs";
import { sleepUnlessCancelled } from "./lib/shared/sleep.mjs";
import { parseMicUsers, pipewireEnvironment } from "./lib/pipewire.mjs";
import { startSupervisor } from "./lib/recorder.mjs";
import { readSettings, VARIABLES } from "./lib/settings.mjs";
import { ensureWhisper, transcribeFile } from "./lib/whisper.mjs";
import { pluginError } from "./lib/errors.mjs";
import { MAX_WAIT_SECONDS, meetingOperations } from "./operations/meetings.mjs";

const execFile = promisify(execFileCallback);
// Transcribing an hour of audio takes minutes; the first one also downloads whisper.cpp.
const CALL_TIMEOUT_MS = 30 * 60 * 1000;

const MEETING_OUTPUTS = [
  { name: "meeting_id", type: "string", description: "Meeting id, for transcribe" },
  { name: "meeting_title", type: "string", description: "\"Zoom meeting, 26 Nov 14:05\"" },
  { name: "meeting_app", type: "string", description: "The program of the meeting" },
  { name: "started_at", type: "string", description: "RFC 3339" },
  { name: "ended_at", type: "string", description: "RFC 3339" },
  { name: "duration_minutes", type: "integer", description: "Length in minutes" },
  { name: "stop_reason", type: "string", description: "stopped, meeting_ended, error or interrupted" },
];

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - `{listMicUsers, startSupervisor, download, execFile, now, sleep, platform}` (object, optional)
 * @returns Plugin definition (object)
 */
export function createPluginDefinition(dependencies = {}) {
  return {
    name: "meeting-notes",
    version: "0.1.0",
    description: "Meeting notes on this computer (Linux, PipeWire): notice a meeting app on the microphone, record your microphone and the computer's sound as two tracks after you agree, and transcribe them locally with whisper.cpp (downloaded on first use); triggers for detected and recorded meetings",
    extraEnv: Object.values(VARIABLES),
    noCredentials: true,
    limits: { timeout_ms: CALL_TIMEOUT_MS, max_concurrency: 4 },
    triggers: [
      {
        id: "meeting_detected",
        title: "When a meeting is detected",
        description: "A meeting app (Zoom, Teams, Meet in a browser…) uses the microphone. Ask before recording: a human-input step, then start_recording.",
        watch: "wait_for_meeting",
        config: { timeout_seconds: 240 },
        outputs: [
          { name: "meeting_app", type: "string", description: "The program, e.g. Zoom or Google Chrome" },
          { name: "message", type: "string", description: "\"Zoom is using the microphone\"" },
          { name: "consent_reminder", type: "string", description: "One line to show when asking" },
          { name: "detected_at", type: "string", description: "RFC 3339" },
        ],
      },
      {
        id: "meeting_recorded",
        title: "When a meeting is recorded",
        description: "A recording stopped (by stop_recording or because the meeting ended). Transcribe it, then summarize and send.",
        watch: "wait_for_recording_end",
        config: { timeout_seconds: 240 },
        outputs: MEETING_OUTPUTS,
      },
    ],
    createClient: ({ environment }) => {
      const settings = readSettings(environment);
      const toolEnvironment = pipewireEnvironment(environment, process.getuid?.());
      const run = dependencies.execFile ?? execFile;
      return {
        settings,
        now: dependencies.now ?? Date.now,
        sleep: dependencies.sleep ?? ((milliseconds, signal) => sleepUnlessCancelled(milliseconds, signal, "Waiting was cancelled")),
        listMicUsers: dependencies.listMicUsers ?? (async (signal) => {
          try {
            const { stdout } = await run("pw-dump", [], { env: toolEnvironment, maxBuffer: 32 * 1024 * 1024, timeout: 15000, signal });
            return parseMicUsers(stdout, process.pid);
          } catch (dumpError) {
            if (dumpError.kind) throw dumpError;
            throw pluginError("api_error", `pw-dump failed (is PipeWire running?): ${String(dumpError.stderr || dumpError.message).trim()}`, { retryable: true });
          }
        }),
        startSupervisor: (options) => (dependencies.startSupervisor ?? startSupervisor)({ ...options, environment: toolEnvironment }),
        ensureWhisper: (signal) => ensureWhisper({
          whisperDirectory: settings.whisperDirectory,
          searchPath: environment.PATH,
          download: dependencies.download ?? downloadPublicHttpsToFile,
          signal,
          platform: dependencies.platform ?? `${process.platform}-${process.arch}`,
        }),
        transcribeFile: (options) => transcribeFile({ ...options, threads: Math.min(8, availableParallelism()), execFile: run }),
      };
    },
    operations: meetingOperations,
  };
}

export { MAX_WAIT_SECONDS };
export const pluginDefinition = createPluginDefinition();
