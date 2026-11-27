/**
 * Operations with a fake process runner: the argument arrays ffmpeg gets, where outputs go, and failure handling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildManifest } from "../lib/shared/operations.mjs";
import { pluginDefinition } from "../definition.mjs";
import { AS_NODE, AS_TOOL, createFakeProcessRunner, withFfmpegRunner } from "./helpers.mjs";

const VIDEO_PROBE = {
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1.000000", size: "17330", bit_rate: "138640" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 320, height: 240, pix_fmt: "yuv420p", avg_frame_rate: "10/1" },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 1, channel_layout: "mono" },
  ],
};

test("manifest: local only, no secrets, nine tools, file and program env declared", () => {
  const manifest = buildManifest(pluginDefinition);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["probe", "transcode", "extract_audio", "resize", "trim", "concatenate", "burn_subtitles", "thumbnail", "make_gif"]);
  assert.equal(manifest.permissions.network, false);
  assert.equal(manifest.permissions.secrets, false);
  for (const variableName of ["FFMPEG_INPUT_DIRS", "FFMPEG_OUTPUT_DIR", "FFMPEG_TIMEOUT_MS", "FFMPEG_BINARY", "FFPROBE_BINARY"]) assert.ok(manifest.permissions.env.includes(variableName));
  assert.ok(manifest.nodes.every((node) => !node.config_schema.properties.access_token));
});

test("probe summarises ffprobe JSON; ffprobe gets the whitelists and the real path", () => {
  const fake = createFakeProcessRunner({ probeResult: VIDEO_PROBE });
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    const { data } = await runOperation("probe", { input: "clip.mp4" }, AS_TOOL);
    assert.equal(data.duration_seconds, 1);
    assert.equal(data.has_video, true);
    assert.deepEqual(data.streams[0], { index: 0, type: "video", codec: "h264", codec_long_name: null, duration_seconds: null, bit_rate: null, language: null, width: 320, height: 240, pixel_format: "yuv420p", frame_rate: 10, rotation: 0 });
    const { args } = fake.requests[0];
    assert.equal(fake.requests[0].command, "ffprobe");
    assert.deepEqual(args.slice(3, 5), ["-protocol_whitelist", "file"]);
    assert.equal(args.at(-1), `file:${join(inputDirectory, "clip.mp4")}`);
  });
});

test("transcode writes a new generated file in the output directory with the preset's arguments", () => {
  const fake = createFakeProcessRunner();
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    const { data } = await runOperation("transcode", { input: join(inputDirectory, "clip.mp4"), format: "webm", quality: "low" }, AS_TOOL);
    assert.match(data.file_name, /^clip-\d{8}-\d{6}-[0-9a-f]{8}\.webm$/);
    assert.equal(data.path, join(outputDirectory, data.file_name));
    assert.equal(data.size_bytes, 100);
    assert.deepEqual(fake.requests.map((request) => request.displayName), ["ffprobe", "ffmpeg"]);
    const { args, command } = fake.requests[1];
    assert.equal(command, "ffmpeg");
    assert.deepEqual(args.slice(0, 7), ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-filter_threads", "4"]);
    assert.ok(args.indexOf("-protocol_whitelist") < args.indexOf("-i"));
    assert.deepEqual(args.slice(args.indexOf("-i") - 4, args.indexOf("-i")), ["-max_pixels", String(7680 * 4320), "-threads", "4"]);
    const stagingTarget = args.at(-1);
    assert.ok(stagingTarget.startsWith("file:"), stagingTarget);
    const stagingPath = stagingTarget.slice("file:".length);
    assert.deepEqual([dirname(dirname(stagingPath)), basename(stagingPath)], [outputDirectory, "output.webm"]);
    assert.match(basename(dirname(stagingPath)), /^\.staging-/);
    assert.deepEqual(args.slice(-6, -1), ["-threads", "4", "-fs", String(2 * 1024 ** 3), "-n"]);
    assert.deepEqual(await readdir(outputDirectory), [data.file_name]);
    assert.ok(args.includes("libvpx-vp9") && args.includes("40"));
    assert.equal(await readFile(join(inputDirectory, "clip.mp4"), "utf8"), "x");
  });
});

test("transcode extra_args: tools are refused before anything runs; nodes may pass allowlisted options", () => {
  const fake = createFakeProcessRunner();
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    const request = { input: "clip.mp4", format: "mp4", extra_args: ["-preset", "slow"] };
    await assert.rejects(runOperation("transcode", request, AS_TOOL), { kind: "permission_denied" });
    assert.equal(fake.requests.length, 0);
    await runOperation("transcode", request, AS_NODE);
    assert.deepEqual(fake.requests[1].args.slice(-8, -6), ["-preset", "slow"]);
    await assert.rejects(runOperation("transcode", { ...request, extra_args: ["-vf", "movie=/etc/passwd"] }, AS_NODE), { kind: "invalid_input" });
  });
});

test("inputs outside the allowlist or with non-media extensions are refused before ffmpeg runs", () => {
  const fake = createFakeProcessRunner();
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory, outsideDirectory }) => {
    await writeFile(join(outsideDirectory, "secret.mp4"), "x");
    await writeFile(join(inputDirectory, "list.txt"), "x");
    await assert.rejects(runOperation("probe", { input: join(outsideDirectory, "secret.mp4") }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("probe", { input: "../outside/secret.mp4" }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("probe", { input: "concat:/etc/passwd|x.mp4" }, AS_TOOL), { kind: "not_found" });
    await assert.rejects(runOperation("probe", { input: "list.txt" }, AS_TOOL), { kind: "invalid_input" });
    assert.equal(fake.requests.length, 0);
  });
});

test("an ffmpeg failure removes the reserved output and reports ffmpeg's message", () => {
  const fake = createFakeProcessRunner({ failWith: "[mov] moov atom not found\nclip.mp4: Invalid data found when processing input" });
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    await assert.rejects(runOperation("transcode", { input: "clip.mp4", format: "mp4" }, AS_TOOL), (error) => error.kind === "invalid_input" && /moov atom/.test(error.message));
    assert.deepEqual(await readdir(outputDirectory), []);
  });
});

test("an output that reaches the size cap is removed", () => {
  const fake = createFakeProcessRunner({ outputBytes: 2048 });
  return withFfmpegRunner({ runProcess: fake.runProcess, environment: { FFMPEG_MAX_OUTPUT_BYTES: "2048" } }, async ({ runOperation, inputDirectory, outputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    await assert.rejects(runOperation("transcode", { input: "clip.mp4", format: "mp4" }, AS_TOOL), { kind: "invalid_input" });
    assert.deepEqual(await readdir(outputDirectory), []);
  });
});

test("no output directory: setup_required; reads still work", () => {
  const fake = createFakeProcessRunner({ probeResult: VIDEO_PROBE });
  return withFfmpegRunner({ runProcess: fake.runProcess, environment: { FFMPEG_OUTPUT_DIR: "" } }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    await assert.rejects(runOperation("thumbnail", { input: "clip.mp4" }, AS_TOOL), { kind: "setup_required" });
    assert.equal((await runOperation("probe", { input: "clip.mp4" }, AS_TOOL)).data.has_audio, true);
  });
});

test("concatenate probes every part, then joins them through a generated, quoted list", () => {
  const fake = createFakeProcessRunner({ probeResult: VIDEO_PROBE });
  let listContent = null;
  const runProcess = async (request) => {
    if (request.displayName === "ffmpeg") listContent = await readFile(request.args[request.args.indexOf("-i") + 1].replace(/^file:/, ""), "utf8");
    return fake.runProcess(request);
  };
  return withFfmpegRunner({ runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "a.mp4"), "x");
    await writeFile(join(inputDirectory, "b.mp4"), "x");
    const { data } = await runOperation("concatenate", { inputs: ["a.mp4", "b.mp4"] }, AS_TOOL);
    assert.equal(data.input_count, 2);
    assert.match(data.file_name, /^joined-.*\.mp4$/);
    assert.equal(listContent, `ffconcat version 1.0\nfile '${join(inputDirectory, "a.mp4")}'\nfile '${join(inputDirectory, "b.mp4")}'\n`);
    assert.deepEqual(fake.requests.map((request) => request.displayName), ["ffprobe", "ffprobe", "ffmpeg"]);
    const ffmpegArguments = fake.requests[2].args;
    assert.ok(ffmpegArguments.join(" ").includes("-format_whitelist concat,mov"));
    assert.deepEqual(ffmpegArguments.slice(ffmpegArguments.indexOf("-i") - 8, ffmpegArguments.indexOf("-i") - 4), ["-f", "concat", "-safe", "0"]);
    await assert.rejects(runOperation("concatenate", { inputs: ["a.mp4"] }, AS_TOOL), { kind: "invalid_input" });
  });
});

test("concatenate refuses stream copy when the parts differ", () => {
  let probeCount = 0;
  const otherSize = { ...VIDEO_PROBE, streams: [{ ...VIDEO_PROBE.streams[0], width: 640 }, VIDEO_PROBE.streams[1]] };
  const runProcess = async (request) => {
    probeCount += 1;
    return { exitCode: 0, signalCode: null, stdout: Buffer.from(JSON.stringify(probeCount === 1 ? VIDEO_PROBE : otherSize)), stdoutTruncated: false, stderr: "" };
  };
  return withFfmpegRunner({ runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "a.mp4"), "x");
    await writeFile(join(inputDirectory, "b.mp4"), "x");
    await assert.rejects(runOperation("concatenate", { inputs: ["a.mp4", "b.mp4"] }, AS_TOOL), (error) => error.kind === "invalid_input" && /reencode=true/.test(error.message));
  });
});

test("burn_subtitles gives ffmpeg a re-written .srt copy, never the original path", () => {
  let subtitleCopy = null;
  const fake = createFakeProcessRunner();
  const runProcess = async (request) => {
    if (request.displayName === "ffprobe") return fake.runProcess(request);
    const filterText = request.args[request.args.indexOf("-vf") + 1];
    const subtitlePath = /subtitles=filename=([^:]+)/.exec(filterText)[1];
    subtitleCopy = { path: subtitlePath, content: await readFile(subtitlePath, "utf8") };
    return fake.runProcess(request);
  };
  return withFfmpegRunner({ runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    await writeFile(join(inputDirectory, "subs.srt"), "1\r\n00:00:00,000 --> 00:00:00,900\r\nHalo\r\n");
    if (process.platform === "win32") {
      // Known gap: a Windows path (C:\\...) has characters the subtitles filter is not given, so burn_subtitles
      // is refused there before ffmpeg starts. The rest of this test needs the filter.
      await assert.rejects(runOperation("burn_subtitles", { input: "clip.mp4", subtitles: "subs.srt", font_size: 30 }, AS_TOOL), { kind: "setup_required", message: /characters ffmpeg filters cannot take safely/ });
      return;
    }
    await runOperation("burn_subtitles", { input: "clip.mp4", subtitles: "subs.srt", font_size: 30 }, AS_TOOL);
    assert.notEqual(subtitleCopy.path, join(inputDirectory, "subs.srt"));
    assert.equal(subtitleCopy.content, "1\n00:00:00,000 --> 00:00:00,900\nHalo\n");
    await writeFile(join(inputDirectory, "fake.srt"), "#EXTM3U\nfile:/etc/passwd\n");
    await assert.rejects(runOperation("burn_subtitles", { input: "clip.mp4", subtitles: "fake.srt" }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("burn_subtitles", { input: "clip.mp4", subtitles: "clip.mp4" }, AS_TOOL), { kind: "invalid_input" });
  });
});

test("thumbnail and make_gif: one frame / capped GIF, numbers validated", () => {
  const fake = createFakeProcessRunner();
  return withFfmpegRunner({ runProcess: fake.runProcess }, async ({ runOperation, inputDirectory }) => {
    await writeFile(join(inputDirectory, "clip.mp4"), "x");
    const thumbnail = await runOperation("thumbnail", { input: "clip.mp4", time: "00:00:00.5", format: "png", target_width: "160" }, AS_TOOL);
    assert.match(thumbnail.data.file_name, /\.png$/);
    const [thumbnailCall, gifCall] = fake.requests.filter((request) => request.displayName === "ffmpeg");
    assert.ok(thumbnailCall.args.join(" ").includes("-ss 0.5 -max_pixels"));
    assert.ok(thumbnailCall.args.includes("-frames:v"));
    await runOperation("make_gif", { input: "clip.mp4", duration: 2, fps: 12, target_width: 200 }, AS_TOOL);
    assert.ok(fake.requests.filter((request) => request.displayName === "ffmpeg").at(-1).args.join(" ").includes("fps=12,scale=200:-1"));
    await assert.rejects(runOperation("make_gif", { input: "clip.mp4", duration: 31 }, AS_TOOL), { kind: "invalid_input" });
    await assert.rejects(runOperation("thumbnail", { input: "clip.mp4", time: "soon" }, AS_TOOL), { kind: "invalid_input" });
  });
});
