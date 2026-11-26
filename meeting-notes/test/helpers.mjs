/** Test helpers: WAV files and a plugin over a temp meetings directory with fakes. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

/**
 * A 16-bit mono WAV of 440 Hz tone parts.
 *
 * @param sampleRate - Hz (number)
 * @param parts - `[[durationMs, amplitude]]` (Array)
 * @returns Buffer
 */
export function wav(sampleRate, parts) {
  const samples = [];
  for (const [durationMs, amplitude] of parts) {
    const count = Math.floor((sampleRate * durationMs) / 1000);
    for (let index = 0; index < count; index += 1) samples.push(Math.round(Math.sin((index * 440 * 2 * Math.PI) / sampleRate) * amplitude));
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Runs `work` with a plugin whose meetings directory is a temp folder and whose microphone, clock, recorder and
 * commands are fakes.
 *
 * @param dependencies - Overrides for createPluginDefinition (object)
 * @param work - `async ({runOperation, directory, clock, mic}) => any` (function)
 */
export async function withPlugin(dependencies, work) {
  const directory = await mkdtemp(join(tmpdir(), "graphrt-meeting-notes-test-"));
  const clock = { nowMs: Date.parse("2026-11-26T09:00:00Z") };
  const mic = { users: [] };
  const definition = createPluginDefinition({
    now: () => clock.nowMs,
    sleep: async (milliseconds) => {
      clock.nowMs += milliseconds;
      await dependencies.onSleep?.(clock, mic);
    },
    listMicUsers: async () => mic.users,
    platform: "linux-x64",
    ...dependencies,
  });
  const runOperation = createOperationRunner(definition, { HOME: directory, MEETING_NOTES_DIR: directory, PATH: "", ...(dependencies.environment ?? {}) });
  try {
    return await work({ runOperation, directory, clock, mic });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const ZOOM = { stream_id: 90, app_name: "ZOOM VoiceEngine", binary: "zoom", pid: 5150 };
