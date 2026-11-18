/**
 * Reads the plugin's environment variables into validated settings.
 *
 * SMTP and IMAP share one password (EMAIL_PASSWORD, read by the runner as the
 * plugin's "token"). The IMAP user defaults to the SMTP user, and the From
 * address defaults to the SMTP user.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isValidEmailAddress } from "./addresses.mjs";
import { invalidInput, setupRequired } from "./errors.mjs";

export const DEFAULT_SMTP_PORT = 465;
export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_DAILY_SEND_LIMIT = 200;
const HOSTNAME_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const BOOLEAN_VALUES = new Map([["true", true], ["1", true], ["yes", true], ["false", false], ["0", false], ["no", false]]);

/**
 * Builds settings from environment variables, applying defaults.
 *
 * @param environment - Environment variables (object)
 * @returns `{smtp, imap, from, dailySendLimit, allowedFileDirectories, toolAllowedRecipients, stateDirectory}` (object);
 *   `smtp`/`imap` are `{host, port, secure, user}` with `host` null when not configured;
 *   `toolAllowedRecipients` is `{addresses, domains}` (lowercased) or null when EMAIL_TOOL_ALLOWED_RECIPIENTS is unset
 * @throws PluginError kind `invalid_input` - When a variable has an invalid value
 */
export function resolveSettings(environment = {}) {
  const homeDirectory = environment.HOME || homedir();
  const smtpUser = readText(environment.EMAIL_SMTP_USER);
  return {
    smtp: {
      host: readHost(environment, "EMAIL_SMTP_HOST"),
      port: readInteger(environment, "EMAIL_SMTP_PORT", DEFAULT_SMTP_PORT, { minimum: 1, maximum: 65535 }),
      secure: readBoolean(environment, "EMAIL_SMTP_SECURE", true),
      user: smtpUser,
    },
    imap: {
      host: readHost(environment, "EMAIL_IMAP_HOST"),
      port: readInteger(environment, "EMAIL_IMAP_PORT", DEFAULT_IMAP_PORT, { minimum: 1, maximum: 65535 }),
      secure: readBoolean(environment, "EMAIL_IMAP_SECURE", true),
      user: readText(environment.EMAIL_IMAP_USER) ?? smtpUser,
    },
    from: readText(environment.EMAIL_FROM) ?? smtpUser,
    dailySendLimit: readInteger(environment, "EMAIL_DAILY_SEND_LIMIT", DEFAULT_DAILY_SEND_LIMIT, { minimum: 0, maximum: 100000 }),
    allowedFileDirectories: readDirectoryList(environment.EMAIL_ALLOWED_FILE_DIRS, homeDirectory),
    toolAllowedRecipients: readRecipientAllowlist(environment.EMAIL_TOOL_ALLOWED_RECIPIENTS),
    stateDirectory: expandHome(readText(environment.EMAIL_STATE_DIR) ?? "~/.graphrt/email", homeDirectory, "EMAIL_STATE_DIR"),
  };
}

/**
 * Returns the SMTP settings, or explains which variables are missing.
 *
 * @param settings - From resolveSettings (object)
 * @returns `{host, port, secure, user}` (object)
 * @throws PluginError kind `setup_required` - When EMAIL_SMTP_HOST or EMAIL_SMTP_USER is not set
 */
export function requireSmtpSettings(settings) {
  if (!settings.smtp.host || !settings.smtp.user) {
    throw setupRequired("SMTP is not configured: set EMAIL_SMTP_HOST and EMAIL_SMTP_USER (see the email plugin README for Gmail and Outlook values)");
  }
  return settings.smtp;
}

/**
 * Returns the IMAP settings, or explains which variables are missing.
 *
 * @param settings - From resolveSettings (object)
 * @returns `{host, port, secure, user}` (object)
 * @throws PluginError kind `setup_required` - When EMAIL_IMAP_HOST or a user is not set
 */
export function requireImapSettings(settings) {
  if (!settings.imap.host || !settings.imap.user) {
    throw setupRequired("IMAP is not configured: set EMAIL_IMAP_HOST and EMAIL_IMAP_USER or EMAIL_SMTP_USER (see the email plugin README)");
  }
  return settings.imap;
}

function readText(rawValue) {
  const trimmed = typeof rawValue === "string" ? rawValue.trim() : "";
  if (/[\r\n\0]/.test(trimmed)) throw invalidInput("Email settings must not contain line breaks");
  return trimmed || null;
}

function readHost(environment, variableName) {
  const host = readText(environment[variableName]);
  if (host && !HOSTNAME_PATTERN.test(host)) throw invalidInput(`${variableName} must be a host name such as smtp.gmail.com, got ${JSON.stringify(host)}`);
  return host;
}

function readInteger(environment, variableName, defaultValue, { minimum, maximum }) {
  const rawValue = readText(environment[variableName]);
  if (rawValue === null) return defaultValue;
  const numericValue = Number(rawValue);
  if (!Number.isInteger(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw invalidInput(`${variableName} must be an integer from ${minimum} to ${maximum}, got ${JSON.stringify(rawValue)}`);
  }
  return numericValue;
}

function readBoolean(environment, variableName, defaultValue) {
  const rawValue = readText(environment[variableName]);
  if (rawValue === null) return defaultValue;
  const booleanValue = BOOLEAN_VALUES.get(rawValue.toLowerCase());
  if (booleanValue === undefined) throw invalidInput(`${variableName} must be true or false, got ${JSON.stringify(rawValue)}`);
  return booleanValue;
}

function expandHome(configuredPath, homeDirectory, variableName) {
  if (configuredPath === "~") return homeDirectory;
  if (configuredPath.startsWith("~/")) return join(homeDirectory, configuredPath.slice(2));
  if (!isAbsolute(configuredPath)) throw invalidInput(`${variableName}: path ${JSON.stringify(configuredPath)} must be absolute or start with ~/`);
  return resolve(configuredPath);
}

// "budi@example.com, @toko.co.id" → { addresses: ["budi@example.com"], domains: ["toko.co.id"] }; unset → null.
function readRecipientAllowlist(rawList) {
  const listText = readText(rawList);
  if (!listText) return null;
  const allowlist = { addresses: [], domains: [] };
  for (const entry of listText.split(",").map((rawEntry) => rawEntry.trim().toLowerCase()).filter(Boolean)) {
    if (entry.startsWith("@") && isValidEmailAddress(`postmaster${entry}`)) allowlist.domains.push(entry.slice(1));
    // "*" is legal in an address but here it would only look like a wildcard that matches nothing.
    else if (!entry.includes("*") && isValidEmailAddress(entry)) allowlist.addresses.push(entry);
    else throw invalidInput(`EMAIL_TOOL_ALLOWED_RECIPIENTS: ${JSON.stringify(entry)} must be an address (budi@example.com) or a domain (@example.com)`);
  }
  return allowlist;
}

function readDirectoryList(rawList, homeDirectory) {
  const listText = readText(rawList);
  if (!listText) return [];
  return listText
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => expandHome(entry, homeDirectory, "EMAIL_ALLOWED_FILE_DIRS"));
}
