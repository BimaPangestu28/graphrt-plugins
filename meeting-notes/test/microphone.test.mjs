import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyMicUser, describeMicUsers, meetingApps } from "../lib/apps.mjs";
import { parseMicUsers, pipewireEnvironment } from "../lib/pipewire.mjs";
import { INITIAL_STATE, observe } from "../lib/detector.mjs";

const FIXTURE = readFileSync(new URL("./fixtures/pw-dump-call.json", import.meta.url), "utf8");

test("finds programs capturing a microphone, not our own streams nor sink monitors", () => {
  assert.deepEqual(parseMicUsers(FIXTURE, 1), [
    { stream_id: 77, app_name: "Google Chrome input", binary: "chrome", pid: 28727 },
    { stream_id: 90, app_name: "ZOOM VoiceEngine", binary: "zoom", pid: 5150 },
  ]);
  assert.deepEqual(parseMicUsers(FIXTURE, 5150).map((user) => user.stream_id), [77]);
});

test("an idle system has no mic users, and other output is refused", () => {
  const idle = JSON.stringify([{ id: 46, type: "PipeWire:Interface:Node", info: { props: { "media.class": "Audio/Source" } } }]);
  assert.deepEqual(parseMicUsers(idle, 1), []);
  assert.throws(() => parseMicUsers("not json", 1), { kind: "api_error" });
  assert.throws(() => parseMicUsers("{}", 1), { kind: "api_error" });
});

test("PipeWire's socket directory is filled in from the uid when the environment lacks it", () => {
  assert.equal(pipewireEnvironment({ PATH: "/usr/bin", HOME: "/home/u" }, 1000).XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(pipewireEnvironment({ XDG_RUNTIME_DIR: "/custom" }, 1000).XDG_RUNTIME_DIR, "/custom");
});

test("names meeting apps, skips audio tools, one entry per program with meeting apps first", () => {
  assert.equal(classifyMicUser({ app_name: "ZOOM VoiceEngine", binary: "zoom" }).label, "Zoom");
  assert.equal(classifyMicUser({ app_name: "teams-for-linux" }).kind, "teams");
  assert.equal(classifyMicUser({ app_name: "pavucontrol", binary: "pavucontrol" }), null);
  assert.equal(classifyMicUser({ app_name: " ", binary: "arecord" }).label, "arecord");
  const apps = meetingApps([
    { stream_id: 1, app_name: "Google Chrome input", binary: "chrome", pid: 11 },
    { stream_id: 2, app_name: "Google Chrome input", binary: "chrome", pid: 11 },
    { stream_id: 3, app_name: "ZOOM VoiceEngine", binary: "zoom", pid: 10 },
  ]);
  assert.deepEqual(apps.map((app) => app.label), ["Zoom", "Google Chrome"]);
  assert.equal(describeMicUsers(apps), "Zoom and Google Chrome are using the microphone");
  assert.equal(describeMicUsers([]), "A program is using the microphone");
});

const TIMING = { confirmMs: 5000, releaseMs: 15000 };

function run(observations) {
  let state = { ...INITIAL_STATE };
  return observations.map(([seconds, inUse, isRecording = false]) => {
    const step = observe(state, { now: seconds * 1000, inUse, isRecording }, TIMING);
    state = step.state;
    return step.detected;
  });
}

test("reports a meeting once, after the microphone stays in use", () => {
  assert.deepEqual(run([[0, true], [3, true], [6, true], [9, true]]), [false, false, true, false]);
});

test("a short microphone check is not a meeting", () => {
  assert.deepEqual(run([[0, true], [3, false], [6, true], [11, true]]), [false, false, false, true]);
});

test("the same meeting is not reported again until the microphone is released", () => {
  const detected = run([[0, true], [5, true], [10, false], [20, true], [24, true], [40, false], [56, false], [60, true], [66, true]]);
  assert.deepEqual(detected, [false, true, false, false, false, false, false, false, true]);
});

test("nothing is reported while recording, nor for that meeting afterwards", () => {
  assert.deepEqual(run([[0, true, true], [10, true, true], [20, true], [30, true]]), [false, false, false, false]);
});
