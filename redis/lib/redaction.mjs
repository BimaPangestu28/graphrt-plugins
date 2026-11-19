/**
 * Hides connection secrets in every text that leaves the plugin.
 *
 * A Redis URL carries the password in its userinfo
 * (`redis://:secret@host` or `rediss://user:secret@host`). Driver errors can quote the string, the
 * host or the user, so every error message and log line passes through a
 * redactor built from the configured URL, and any other `scheme://user:pass@`
 * userinfo is masked by pattern as a second line of defence.
 */

const REDACTED = "[redacted]";
// Shorter secrets would mangle ordinary words in messages; a real password is never this short.
const MIN_REDACTABLE_LENGTH = 3;
// `scheme://user:password@` anywhere in a text (the password part never contains `@` or whitespace).
const USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*):[^\s@/]*@/gi;
// `?password=…` / `&password=…` in a query string (ioredis reads the password from there too).
const QUERY_PASSWORD_PATTERN = /([?&]password=)[^&#\s]*/gi;

/**
 * Lists the forms the URL's password can take (in the userinfo or a `password=` query parameter):
 * as written (percent-encoded), decoded, and the whole connection string.
 *
 * @param connectionUrl - The configured connection string (string)
 * @returns Secret strings to redact (string[])
 *
 * @example
 * buildUrlSecrets("redis://:p%40ss@cache:6379/0"); // ["redis://:p%40ss@cache:6379/0", "p%40ss", "p@ss"]
 */
export function buildUrlSecrets(connectionUrl) {
  if (!connectionUrl) return [];
  const secrets = [connectionUrl];
  for (const encodedPassword of [extractEncodedPassword(connectionUrl), extractQueryPassword(connectionUrl)]) {
    if (encodedPassword) secrets.push(encodedPassword, safeDecode(encodedPassword));
  }
  return [...new Set(secrets)].filter((secret) => secret.length >= MIN_REDACTABLE_LENGTH);
}

/**
 * Creates a function that replaces every secret, and any URL userinfo password, with "[redacted]".
 *
 * @param secrets - Strings to hide (string[])
 * @returns `(text) => redactedText` (function)
 *
 * @example
 * const redact = createRedactor(buildUrlSecrets(url));
 * redact(`connect ${url} failed`); // "connect [redacted] failed"
 */
export function createRedactor(secrets) {
  const longestFirst = [...new Set(secrets)].filter(Boolean).sort((left, right) => right.length - left.length);
  return (text) => {
    let redactedText = String(text ?? "");
    for (const secret of longestFirst) redactedText = redactedText.split(secret).join(REDACTED);
    return redactedText.replace(USERINFO_PATTERN, `$1:${REDACTED}@`).replace(QUERY_PASSWORD_PATTERN, `$1${REDACTED}`);
  };
}

/**
 * Returns the connection string with its password replaced, for display.
 *
 * @param connectionUrl - Connection string (string)
 * @returns The same string with `:[redacted]@` in place of the password (string)
 */
export function maskConnectionUrl(connectionUrl) {
  return String(connectionUrl ?? "").replace(USERINFO_PATTERN, `$1:${REDACTED}@`);
}

function extractEncodedPassword(connectionUrl) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^@/?#]*)@/i.exec(connectionUrl);
  if (!match) return null;
  const separatorIndex = match[1].indexOf(":");
  return separatorIndex === -1 ? null : match[1].slice(separatorIndex + 1) || null;
}

function extractQueryPassword(connectionUrl) {
  const match = /[?&]password=([^&#\s]*)/i.exec(connectionUrl);
  return match?.[1] || null;
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
