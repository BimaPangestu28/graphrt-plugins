/**
 * Picture outputs from a video: a single-frame thumbnail and an animated GIF.
 */
import { buildGifFilter, buildInputArguments, buildScaleFilter, parseTimestamp } from "../lib/ffmpeg-arguments.mjs";
import { buildNameHint } from "../lib/file-access.mjs";
import { DIMENSION_SCHEMA, INPUT_PARAMETER, OUTPUT_NAME_PARAMETER, TIME_PARAMETER_DESCRIPTION } from "./parameters.mjs";
import { openMediaInput } from "./media-input.mjs";

const IMAGE_ENCODERS = {
  jpg: ["-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj420p", "-f", "image2"],
  png: ["-c:v", "png", "-f", "image2"],
  webp: ["-c:v", "libwebp", "-quality", "85", "-f", "image2"],
};
const MAX_GIF_SECONDS = 30;

const thumbnailOperation = {
  name: "thumbnail",
  title: "Grab a frame",
  description: "Saves one video frame at a given time as a jpg, png or webp image, optionally scaled to a width",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      time: { type: "string", default: "0", description: `Frame time, ${TIME_PARAMETER_DESCRIPTION}` },
      format: { type: "string", enum: Object.keys(IMAGE_ENCODERS), default: "jpg", description: "Image format" },
      target_width: { ...DIMENSION_SCHEMA, description: "Scale to this width in pixels (height keeps the aspect ratio)" },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal, source }) => {
    const seekSeconds = parseTimestamp(args.time, "time");
    const { realPath } = await openMediaInput(client, args.input, { source, signal });
    const scaleArguments = args.target_width ? ["-vf", buildScaleFilter({ width: args.target_width })] : [];
    const outputFile = await client.produceOutput({
      naming: { nameHint: buildNameHint(args.output_name, realPath), extension: args.format },
      buildArguments: () => [...buildInputArguments(realPath, { seekSeconds }), "-map", "0:v:0", ...scaleArguments, "-frames:v", "1", "-update", "1", ...IMAGE_ENCODERS[args.format]],
      signal,
    });
    return { data: { ...outputFile, format: args.format, time_seconds: seekSeconds } };
  },
};

const makeGifOperation = {
  name: "make_gif",
  title: "Make a GIF",
  description: "Turns up to 30 seconds of a video into an animated GIF with a generated palette (frame rate and width are capped)",
  parameters: {
    type: "object",
    properties: {
      input: INPUT_PARAMETER,
      start: { type: "string", default: "0", description: `Start time, ${TIME_PARAMETER_DESCRIPTION}` },
      duration: { type: "number", minimum: 0.1, maximum: MAX_GIF_SECONDS, default: 3, description: "Length in seconds (at most 30)" },
      fps: { type: "integer", minimum: 1, maximum: 30, default: 10, description: "Frames per second" },
      target_width: { type: "integer", minimum: 16, maximum: 1280, default: 480, description: "Width in pixels (height keeps the aspect ratio)" },
      output_name: OUTPUT_NAME_PARAMETER,
    },
    required: ["input"],
  },
  run: async ({ client, args, signal, source }) => {
    const seekSeconds = parseTimestamp(args.start, "start");
    const { realPath } = await openMediaInput(client, args.input, { source, signal });
    const outputFile = await client.produceOutput({
      naming: { nameHint: buildNameHint(args.output_name, realPath), extension: "gif" },
      buildArguments: () => [
        ...buildInputArguments(realPath, { seekSeconds, durationSeconds: args.duration }),
        "-map", "0:v:0", "-vf", buildGifFilter({ fps: args.fps, width: args.target_width }), "-loop", "0", "-f", "gif",
      ],
      signal,
    });
    return { data: { ...outputFile, format: "gif", start_seconds: seekSeconds, duration_seconds: args.duration } };
  },
};

export const frameOperations = [thumbnailOperation, makeGifOperation];
