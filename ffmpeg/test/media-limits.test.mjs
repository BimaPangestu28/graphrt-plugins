/**
 * Review regressions: decoded-size and duration limits checked from ffprobe before ffmpeg decodes,
 * decoder limits on every input, staged outputs, and redacted error messages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyDecoderLimits } from "../lib/client.mjs";
import { AS_NODE, AS_TOOL, SKIP_WITHOUT_FFMPEG, createFakeProcessRunner, generateTestVideo, withFfmpegRunner } from "./helpers.mjs";

function probeOf({ width = 320, height = 240, duration = "1.0" } = {}) {
  return { format: { format_name: "mov,mp4", duration }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width, height }] };
}

test("applyDecoderLimits puts -max_pixels and -threads in front of every input", () => {
  assert.deepEqual(applyDecoderLimits(["-ss", "1", "-i", "file:/a", "-i", "file:/b", "-c", "copy"], { maxPixels: 100, threads: 2 }), [
    "-ss", "1", "-max_pixels", "100", "-threads", "2", "-i", "file:/a", "-max_pixels", "100", "-threads", "2", "-i", "file:/b", "-c", "copy",
  ]);
});

test("review regression: a stream over FFMPEG_MAX_INPUT_PIXELS is refused before ffmpeg decodes it", () => {
  const fake = createFakeProcessRunner({ probeResult: probeOf({ width: 30000, height: 30000 }) });
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeFile(join(inputDirectory, "huge.mp4"), "x");
    for (const [operation, args] of [["transcode", { format: "mp4" }], ["thumbnail", {}], ["make_gif", {}], ["resize", { target_width: 100 }], ["trim", { duration: "1" }]]) {
      await assert.rejects(runOperation(operation, { input: "huge.mp4", ...args }, AS_NODE), (error) => error.kind === "invalid_input" && /FFMPEG_MAX_INPUT_PIXELS/.test(error.message), operation);
    }
    assert.ok(fake.requests.every((request) => request.displayName === "ffprobe"));
    assert.deepEqual(await readdir(outputDirectory), []);
  });
});

test("review regression: agent calls refuse inputs longer than FFMPEG_MAX_INPUT_SECONDS; nodes may process them", () => {
  const fake = createFakeProcessRunner({ probeResult: probeOf({ duration: "7200.0" }) });
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "long.mp4"), "x");
    await writeFile(join(inputDirectory, "long2.mp4"), "x");
    await assert.rejects(runOperation("extract_audio", { input: "long.mp4" }, AS_TOOL), (error) => error.kind === "invalid_input" && /FFMPEG_MAX_INPUT_SECONDS/.test(error.message));
    assert.match((await runOperation("extract_audio", { input: "long.mp4" }, AS_NODE)).data.file_name, /\.mp3$/);
    await assert.rejects(runOperation("concatenate", { inputs: ["long.mp4", "long2.mp4"] }, AS_TOOL), (error) => /FFMPEG_MAX_INPUT_SECONDS/.test(error.message));
  });
});

test("review regression: concatenated parts that are each short but long together are refused for agents", () => {
  const fake = createFakeProcessRunner({ probeResult: probeOf({ duration: "40.0" }) });
  return withFfmpegRunner({ runProcess: fake.runProcess, environment: { FFMPEG_MAX_INPUT_SECONDS: "60" } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "a.mp4"), "x");
    await writeFile(join(inputDirectory, "b.mp4"), "x");
    await assert.rejects(runOperation("concatenate", { inputs: ["a.mp4", "b.mp4"] }, AS_TOOL), (error) => /add up to more than 60 s/.test(error.message));
  });
});

test("review regression: ffmpeg error messages do not reveal paths outside the allowed directories", () => {
  const fake = createFakeProcessRunner({ failWith: "dyld: Library not loaded: /opt/homebrew/lib/libx.dylib\n/var/folders/xy/T/graphrt-ffmpeg-1/inputs.ffconcat: Invalid data found when processing input" });
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    await assert.rejects(runOperation("probe", { input: "clip.mp4" }, AS_TOOL), (error) => error.message.includes("[path]") && !error.message.includes("/opt/homebrew") && !error.message.includes("/var/folders"));
  });
});

test("review regression: real ffmpeg honours -max_pixels and FFMPEG_MAX_INPUT_PIXELS, and leaves no staging directory", { skip: SKIP_WITHOUT_FFMPEG, timeout: 60000 }, () =>
  withFfmpegRunner({ environment: { FFMPEG_MAX_INPUT_PIXELS: "50000" } }, async ({ runOperation, inputDirectory, outputDirectory }) => {
    generateTestVideo(join(inputDirectory, "clip.mp4"));
    generateTestVideo(join(inputDirectory, "small.mp4"), { size: "160x120" });
    await assert.rejects(runOperation("thumbnail", { input: "clip.mp4" }, AS_TOOL), (error) => /320x240 video stream, over the 50000-pixel limit/.test(error.message));
    const thumbnail = await runOperation("thumbnail", { input: "small.mp4", format: "png" }, AS_TOOL);
    assert.deepEqual(await readdir(outputDirectory), [thumbnail.data.file_name]);
  }));
