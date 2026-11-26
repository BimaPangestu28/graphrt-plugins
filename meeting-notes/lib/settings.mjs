/** The plugin's environment variables. All optional. */
import { isAbsolute, join, resolve } from "node:path";
import { invalidInput } from "./errors.mjs";

export const VARIABLES = {
  dir: "MEETING_NOTES_DIR",
  whisperDir: "MEETING_NOTES_WHISPER_DIR",
  autoStopSeconds: "MEETING_NOTES_AUTO_STOP_SECONDS",
  language: "MEETING_NOTES_LANGUAGE",
};

export const DEFAULT_AUTO_STOP_SECONDS = 30;
export const LANGUAGE_PATTERN = /^(auto|[a-z]{2,3})$/;

function expandDirectory(value, homeDirectory, name) {
  const trimmed = value.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homeDirectory, trimmed.slice(1)) : trimmed;
  if (!isAbsolute(expanded)) throw invalidInput(`${name} must be an absolute path or start with ~/`);
  return resolve(expanded);
}

/**
 * Reads the settings.
 *
 * @param environment - Environment variables (object)
 * @returns `{meetingsDirectory, whisperDirectory, autoStopSeconds, language, homeDirectory}` (object)
 * @throws PluginError kind `invalid_input` - For a relative directory, a bad number or language
 */
export function readSettings(environment) {
  const homeDirectory = environment.HOME || "/";
  const dataHome = environment.XDG_DATA_HOME?.trim() ? environment.XDG_DATA_HOME.trim() : join(homeDirectory, ".local", "share");
  const meetingsDirectory = environment[VARIABLES.dir]?.trim()
    ? expandDirectory(environment[VARIABLES.dir], homeDirectory, VARIABLES.dir)
    : join(dataHome, "graphrt-meeting-notes");
  const whisperDirectory = environment[VARIABLES.whisperDir]?.trim()
    ? expandDirectory(environment[VARIABLES.whisperDir], homeDirectory, VARIABLES.whisperDir)
    : join(meetingsDirectory, "whisper");
  const autoStopText = environment[VARIABLES.autoStopSeconds]?.trim();
  const autoStopSeconds = autoStopText ? Number(autoStopText) : DEFAULT_AUTO_STOP_SECONDS;
  if (!Number.isInteger(autoStopSeconds) || autoStopSeconds < 5 || autoStopSeconds > 3600) {
    throw invalidInput(`${VARIABLES.autoStopSeconds} must be a whole number of seconds from 5 to 3600`);
  }
  const language = environment[VARIABLES.language]?.trim().toLowerCase() || "auto";
  if (!LANGUAGE_PATTERN.test(language)) throw invalidInput(`${VARIABLES.language} must be auto or a language code such as en or id`);
  return { meetingsDirectory, whisperDirectory, autoStopSeconds, language, homeDirectory };
}
