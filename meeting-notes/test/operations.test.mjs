/**
 * The operations over a temp meetings directory, with a fake microphone, clock, supervisor and whisper-cli.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { readMeeting, STOP_REQUEST_FILE, writeMeeting } from "../lib/store.mjs";
import { CONSENT_REMINDER } from "../operations/meetings.mjs";
import { wav, withPlugin, ZOOM } from "./helpers.mjs";

const AS_NODE = { source: "node" };

/** A supervisor that writes the tracks at once and stops when stop.request appears (checked on every sleep). */
function fakeSupervisor(state) {
  return {
    startSupervisor: ({ folder }) => {
      state.started += 1;
      state.folder = folder;
      void writeFile(join(folder, "mic.wav"), wav(16000, [[3000, 40]]));
      void writeFile(join(folder, "system.wav"), wav(16000, [[500, 40], [1500, 8000], [1000, 40]]));
      return process.pid;
    },
    onSleep: async (clock) => {
      if (!state.folder || !existsSync(join(state.folder, STOP_REQUEST_FILE))) return;
      const id = state.folder.split("/").at(-1);
      const directory = state.folder.slice(0, -id.length - 1);
      const meeting = await readMeeting(directory, id);
      if (meeting.status === "recording") {
        await writeMeeting(directory, { ...meeting, status: "recorded", ended_at: new Date(clock.nowMs).toISOString(), stop_reason: "stopped" });
      }
    },
  };
}

/** whisper-cli that "hears" speech at 0.6 s and an invented line at 4 s. */
function fakeWhisper(calls) {
  return async (program, args) => {
    calls.push({ program, audio: args[args.indexOf("-f") + 1], language: args[args.indexOf("-l") + 1] });
    const prefix = args[args.indexOf("-of") + 1];
    await writeFile(`${prefix}.json`, JSON.stringify({ transcription: [
      { offsets: { from: 600, to: 1800 }, text: " Hello everyone." },
      { offsets: { from: 4000, to: 5000 }, text: " Thank you." },
    ] }));
    return { stdout: "", stderr: "" };
  };
}

async function installFakeWhisper(directory) {
  await mkdir(join(directory, "whisper"), { recursive: true });
  await writeFile(join(directory, "whisper", "whisper-cli"), "#!/bin/sh\n");
  await writeFile(join(directory, "whisper", "ggml-base.bin"), "model");
}

test("the manifest declares both triggers on watch nodes; recording and transcription are node only", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["detect", "recording_status"]);
  assert.deepEqual(pluginDefinition.triggers.map((trigger) => [trigger.id, trigger.watch]), [
    ["meeting_detected", "wait_for_meeting"],
    ["meeting_recorded", "wait_for_recording_end"],
  ]);
  assert.equal(manifest.permissions.secrets, false);
  assert.ok(manifest.permissions.env.every((name) => /_(DIR|SECONDS|LANGUAGE)$/.test(name)), "every setting is optional tuning");
});

test("detect lists the meeting apps on the microphone", async () => {
  await withPlugin({}, async ({ runOperation, mic }) => {
    mic.users = [ZOOM];
    const { data } = await runOperation("detect", {}, AS_NODE);
    assert.equal(data.in_use, true);
    assert.equal(data.message, "Zoom is using the microphone");
    assert.equal(data.recording, null);
  });
});

test("wait_for_meeting reports a meeting once, with the consent reminder, and resumes from its cursor", async () => {
  await withPlugin({}, async ({ runOperation, mic }) => {
    mic.users = [ZOOM];
    const first = await runOperation("wait_for_meeting", { timeout_seconds: 60, poll_interval_ms: 3000 }, AS_NODE);
    assert.equal(first.data.events.length, 1);
    const [event] = first.data.events;
    assert.equal(event.meeting_app, "Zoom");
    assert.equal(event.consent_reminder, CONSENT_REMINDER);
    const again = await runOperation("wait_for_meeting", { cursor: first.data.cursor, timeout_seconds: 30 }, AS_NODE);
    assert.deepEqual(again.data.events, [], "the same meeting is not offered twice");
    await assert.rejects(runOperation("wait_for_meeting", { cursor: "nope", timeout_seconds: 1 }, AS_NODE), { kind: "invalid_input" });
  });
});

test("without a meeting, wait_for_meeting returns no event when its time is up", async () => {
  await withPlugin({}, async ({ runOperation, clock }) => {
    const startedAt = clock.nowMs;
    const { data } = await runOperation("wait_for_meeting", { timeout_seconds: 20 }, AS_NODE);
    assert.deepEqual(data.events, []);
    assert.equal(clock.nowMs - startedAt, 20000);
  });
});

test("record, stop, the meeting_recorded event, transcribe without silence, delete the audio", async () => {
  const supervisor = { started: 0 };
  const whisperCalls = [];
  await withPlugin({ ...fakeSupervisor(supervisor), execFile: fakeWhisper(whisperCalls) }, async ({ runOperation, directory, mic }) => {
    mic.users = [ZOOM];
    await installFakeWhisper(directory);
    const watch = await runOperation("wait_for_recording_end", { timeout_seconds: 1 }, AS_NODE);
    assert.deepEqual(watch.data.events, []);

    const started = await runOperation("start_recording", { meeting_app: "Zoom" }, AS_NODE);
    assert.equal(started.data.status, "recording");
    assert.match(started.data.meeting_title, /^Zoom meeting, /);
    await assert.rejects(runOperation("start_recording", {}, AS_NODE), /Already recording/);
    assert.equal((await runOperation("recording_status", {}, AS_NODE)).data.recording.meeting_id, started.data.meeting_id);
    await assert.rejects(runOperation("transcribe", { meeting_id: started.data.meeting_id }, AS_NODE), /still being recorded/);

    const stopped = await runOperation("stop_recording", {}, AS_NODE);
    assert.equal(stopped.data.status, "recorded");
    assert.equal(stopped.data.stop_reason, "stopped");

    const ended = await runOperation("wait_for_recording_end", { cursor: watch.data.cursor, timeout_seconds: 5 }, AS_NODE);
    assert.deepEqual(ended.data.events.map((event) => event.meeting_id), [started.data.meeting_id]);
    const none = await runOperation("wait_for_recording_end", { cursor: ended.data.cursor, timeout_seconds: 3 }, AS_NODE);
    assert.deepEqual(none.data.events, [], "each meeting is reported once");

    const transcript = await runOperation("transcribe", { meeting_id: started.data.meeting_id, language: "id" }, AS_NODE);
    assert.deepEqual(whisperCalls.map((call) => call.audio.split("/").at(-1)), ["system.wav"], "the silent mic track is skipped");
    assert.equal(whisperCalls[0].language, "id");
    assert.deepEqual(transcript.data.lines.map((line) => [line.speaker, line.text]), [["Others", "Hello everyone."]], "the line over silence is dropped");
    assert.match(transcript.data.text, /\[00:00:00\] Others: Hello everyone\./);
    const folder = join(directory, started.data.meeting_id);
    assert.equal(existsSync(join(folder, "system.wav")), false, "audio deleted");
    assert.match(await readFile(join(folder, "transcript.md"), "utf8"), /Hello everyone/);

    const shared = await runOperation("transcribe", { meeting_id: started.data.meeting_id }, AS_NODE);
    assert.equal(shared.data.text, transcript.data.text, "a second agent gets the same transcript");
    assert.equal(whisperCalls.length, 1);
  });
});

test("keep_audio keeps the tracks, and a failed transcription keeps them too", async () => {
  const supervisor = { started: 0 };
  const failing = async () => {
    throw Object.assign(new Error("boom"), { stderr: "error: bad model\n" });
  };
  await withPlugin({ ...fakeSupervisor(supervisor), execFile: failing }, async ({ runOperation, directory }) => {
    await installFakeWhisper(directory);
    const { data } = await runOperation("start_recording", {}, AS_NODE);
    await runOperation("stop_recording", {}, AS_NODE);
    await assert.rejects(runOperation("transcribe", { meeting_id: data.meeting_id, keep_audio: true }, AS_NODE), /bad model/);
    const meeting = await readMeeting(directory, data.meeting_id);
    assert.equal(meeting.status, "failed");
    assert.ok(existsSync(join(directory, data.meeting_id, "system.wav")));
  });
});

test("a recording whose supervisor is gone counts as recorded", async () => {
  await withPlugin({ startSupervisor: () => 2 ** 22 + 12345 }, async ({ runOperation }) => {
    const { data } = await runOperation("start_recording", {}, AS_NODE);
    const status = await runOperation("recording_status", {}, AS_NODE);
    assert.equal(status.data.recording, null);
    const ended = await runOperation("wait_for_recording_end", { cursor: undefined, timeout_seconds: 1 }, AS_NODE);
    assert.ok(Array.isArray(ended.data.events));
    assert.ok(data.meeting_id);
  });
});

test("ids and languages are checked", async () => {
  await withPlugin({}, async ({ runOperation }) => {
    await assert.rejects(runOperation("transcribe", { meeting_id: "../etc" }, AS_NODE), { kind: "invalid_input" });
    await assert.rejects(runOperation("transcribe", { meeting_id: "20261126-090000-abcdef", language: "english!" }, AS_NODE), { kind: "invalid_input" });
    await assert.rejects(runOperation("transcribe", { meeting_id: "20261126-090000-abcdef" }, AS_NODE), { kind: "not_found" });
    await assert.rejects(runOperation("stop_recording", {}, AS_NODE), { kind: "not_found" });
  });
});
