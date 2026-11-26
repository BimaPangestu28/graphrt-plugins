/**
 * whisper.cpp on demand: `whisper-cli` and the `ggml-base` model are downloaded the first time a meeting is
 * transcribed, each pinned by SHA-256, through the public-https downloader (https only, public hosts, size cap).
 * A `whisper-cli` already in the whisper directory or on PATH is used instead of downloading.
 */
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { delimiter, join } from "node:path";
import { pluginError } from "./errors.mjs";
import { parseWhisperJson } from "./transcript.mjs";

/** whisper.cpp's multilingual base model, from its Hugging Face repository (the SHA-256 is the LFS hash). */
export const MODEL = {
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  file: "ggml-base.bin",
  bytes: 147951465,
};

/**
 * whisper.cpp v1.9.6 ships no Linux binaries, so graphrt builds a static `whisper-cli` (x86-64-v3, glibc 2.35+) and
 * publishes it with whisper.cpp's MIT license on the `whisper-cpp-v1.9.6` prerelease of graphrt Desktop.
 */
export const PROGRAMS = {
  "linux-x64": {
    url: "https://github.com/Graphrt/graphrt-builder-desktop/releases/download/whisper-cpp-v1.9.6/whisper-cli-v1.9.6-linux-x86_64",
    sha256: "8cb010a7c5776bd664237037e438dacbb13898bda1fb5874a516505bf2286261",
    file: "whisper-cli",
    bytes: 4073288,
  },
};

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;

async function isFile(path) {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Where whisper.cpp is without downloading: the whisper directory, then `whisper-cli` on PATH.
 *
 * @param whisperDirectory - Download directory (string)
 * @param searchPath - PATH (string, optional)
 * @returns `{program, model}`, each a path or null (Promise<object>)
 */
export async function findWhisper(whisperDirectory, searchPath) {
  let program = join(whisperDirectory, "whisper-cli");
  if (!(await isFile(program))) {
    program = null;
    for (const directory of (searchPath ?? "").split(delimiter).filter(Boolean)) {
      if (await isFile(join(directory, "whisper-cli"))) {
        program = join(directory, "whisper-cli");
        break;
      }
    }
  }
  const model = join(whisperDirectory, MODEL.file);
  return { program, model: (await isFile(model)) ? model : null };
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Downloads a pinned file into `directory` unless it is there already.
 *
 * @param pinned - `{url, sha256, file, bytes}` (object)
 * @param options - `{directory, download, signal, executable}`; `download` is the public-https downloader (object)
 * @returns The file's path (Promise<string>)
 * @throws PluginError kind `api_error` - When the download is not the pinned file
 */
export async function ensurePinnedFile(pinned, { directory, download, signal, executable = false }) {
  const target = join(directory, pinned.file);
  if (await isFile(target)) return target;
  await fs.mkdir(directory, { recursive: true });
  const saved = await download(pinned.url, {
    directory,
    fileBaseName: `${pinned.file.replaceAll(".", "-")}-download`,
    maxBytes: pinned.bytes + 1024 * 1024,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    signal,
    label: pinned.file,
  });
  const actual = await sha256File(saved.path);
  if (actual !== pinned.sha256) {
    await fs.rm(saved.path, { force: true });
    throw pluginError("api_error", `The download of ${pinned.file} is not the expected file (SHA-256 ${actual}); nothing was installed`);
  }
  if (executable) await fs.chmod(saved.path, 0o755);
  await fs.rename(saved.path, target);
  return target;
}

/**
 * The whisper.cpp program and model, downloading what is missing.
 *
 * @param options - `{whisperDirectory, searchPath, download, signal, platform}` (object)
 * @returns `{program, model}` (Promise<object>)
 * @throws PluginError kind `not_found` - On a platform without a published whisper-cli and none installed
 */
export async function ensureWhisper({ whisperDirectory, searchPath, download, signal, platform }) {
  const found = await findWhisper(whisperDirectory, searchPath);
  let program = found.program;
  if (!program) {
    const pinned = PROGRAMS[platform];
    if (!pinned) {
      throw pluginError("not_found", `No whisper-cli download for ${platform}; install whisper.cpp's whisper-cli on PATH or put it in the whisper directory`);
    }
    program = await ensurePinnedFile(pinned, { directory: whisperDirectory, download, signal, executable: true });
  }
  const model = found.model ?? (await ensurePinnedFile(MODEL, { directory: whisperDirectory, download, signal }));
  return { program, model };
}

/**
 * whisper-cli arguments writing `<outputPrefix>.json`.
 *
 * @returns Arguments (Array<string>)
 */
export function whisperArguments({ model, audio, language, threads, outputPrefix }) {
  return ["-m", model, "-f", audio, "-l", language, "-t", String(threads), "-oj", "-of", outputPrefix, "-np"];
}

/**
 * Transcribes one WAV file.
 *
 * @param options - `{program, model, audio, language, threads, execFile, signal}`; `execFile` is a promisified
 *   child_process.execFile (object)
 * @returns `[{start_ms, end_ms, text}]` (Promise<Array<object>>)
 * @throws PluginError kind `api_error` - When whisper-cli fails
 */
export async function transcribeFile({ program, model, audio, language, threads, execFile, signal }) {
  const outputPrefix = audio.replace(/\.wav$/, ".whisper");
  try {
    await execFile(program, whisperArguments({ model, audio, language, threads, outputPrefix }), { signal, maxBuffer: 64 * 1024 * 1024 });
  } catch (runError) {
    if (signal?.aborted) throw pluginError("cancelled", "Transcription was cancelled");
    const lastLine = String(runError.stderr ?? runError.message).trim().split("\n").at(-1);
    throw pluginError("api_error", `whisper-cli failed: ${lastLine}`);
  }
  const jsonPath = `${outputPrefix}.json`;
  try {
    return parseWhisperJson(await fs.readFile(jsonPath, "utf8"));
  } finally {
    await fs.rm(jsonPath, { force: true });
  }
}
