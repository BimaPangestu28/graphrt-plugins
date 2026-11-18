/**
 * The app allowlist from COMPUTER_CONTROL_ALLOWED_APPS. It is checked in Node
 * before any script runs, so a disallowed app is never touched.
 *
 * Entries are app names ("WhatsApp") or bundle ids ("net.whatsapp.WhatsApp").
 * Names are compared after NFC normalisation with ASCII-only case folding, the
 * same rule jxa/prelude.js uses to find the running app: Unicode case folding
 * would let e.g. "\u212Aeynote" (Kelvin sign) stand in for "Keynote".
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

export const ALLOWED_APPS_ENV = "COMPUTER_CONTROL_ALLOWED_APPS";
const ALLOW_ALL = "*";
const MAX_APP_NAME_LENGTH = 100;
// Reverse-DNS with at least three labels, so app names such as "draw.io" are not taken for bundle ids.
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/;

/**
 * Normalises an app name or bundle id for comparison: trim, NFC, then lower-case ASCII letters only.
 * Names holding a character that NFC rewrites on its own (Kelvin sign, Ohm sign, Angstrom sign…)
 * get no key at all: NFC would turn "\u212Aeynote" into "Keynote", so such names never match anything.
 *
 * @param appName - App name or bundle id (string)
 * @returns Comparison key, or null for a look-alike name (string | null)
 *
 * @example
 * normalizeAppKey("WhatsApp"); // "whatsapp"
 * normalizeAppKey("\u212Aeynote"); // null
 */
export function normalizeAppKey(appName) {
  const trimmedName = String(appName ?? "").trim();
  if (Array.from(trimmedName).some((character) => character.normalize("NFC") !== character)) return null;
  return trimmedName.normalize("NFC").replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Tells whether an `app` argument is a bundle id such as "net.whatsapp.WhatsApp".
 *
 * @param appName - Validated `app` argument (string)
 * @returns true for reverse-DNS identifiers with three or more labels (boolean)
 */
export function isBundleId(appName) {
  return BUNDLE_ID_PATTERN.test(appName);
}

/**
 * Parses the comma-separated allowlist (case-insensitive for ASCII; `*` allows every app).
 *
 * @param rawValue - Value of COMPUTER_CONTROL_ALLOWED_APPS (string | undefined)
 * @returns `{allowsAll, appNames}` with normalised names and bundle ids (object)
 * @throws PluginError kind `permission_denied` - When the variable is unset or empty
 *
 * @example
 * parseAllowedApps("Finder, net.whatsapp.WhatsApp"); // { allowsAll: false, appNames: Set{"finder","net.whatsapp.whatsapp"} }
 */
export function parseAllowedApps(rawValue) {
  const entries = String(rawValue ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new PluginError(
      `${ALLOWED_APPS_ENV} is not set: list the apps this plugin may control, e.g. ${ALLOWED_APPS_ENV}="Finder,TextEdit" (use "*" for every app, which is risky)`,
      { kind: "permission_denied" },
    );
  }
  const lookAlikeEntry = entries.find((entry) => normalizeAppKey(entry) === null);
  if (lookAlikeEntry) {
    throw new PluginError(`${ALLOWED_APPS_ENV} entry "${lookAlikeEntry}" contains look-alike Unicode characters (e.g. the Kelvin sign); type the name with plain letters`, {
      kind: "permission_denied",
    });
  }
  return { allowsAll: entries.includes(ALLOW_ALL), appNames: new Set(entries.map(normalizeAppKey)) };
}

/**
 * Tells whether an app is on the allowlist.
 *
 * @param appName - App name or bundle id, as shown by list_apps (string)
 * @param allowedApps - Result of parseAllowedApps (object)
 * @returns true when allowed; always false for look-alike names (boolean)
 */
export function isAppAllowed(appName, allowedApps) {
  const appKey = normalizeAppKey(appName);
  if (appKey === null) return false;
  return allowedApps.allowsAll || allowedApps.appNames.has(appKey);
}

/**
 * Validates an app name or bundle id and checks it against the allowlist.
 *
 * @param appName - `app` from the operation arguments (string)
 * @param allowedApps - Result of parseAllowedApps (object)
 * @returns The trimmed app name (string)
 * @throws PluginError kind `invalid_input` - Malformed name; `permission_denied` - App not on the allowlist
 */
export function requireAllowedApp(appName, allowedApps) {
  const trimmedName = validateAppName(appName);
  if (!isAppAllowed(trimmedName, allowedApps)) {
    throw new PluginError(`App "${trimmedName}" is not in ${ALLOWED_APPS_ENV}; add it there to let the plugin control it`, {
      kind: "permission_denied",
    });
  }
  return trimmedName;
}

// Names only, never paths or flags: `open -a` and the allowlist both work on plain app names.
function validateAppName(appName) {
  const trimmedName = String(appName ?? "").trim();
  if (!trimmedName || trimmedName.length > MAX_APP_NAME_LENGTH || trimmedName.startsWith("-") || /[/\\\0\n\r]/.test(trimmedName)) {
    throw new PluginError(`\`app\` must be an app name such as "Finder" (no paths), got "${trimmedName.slice(0, 40)}"`, {
      kind: "invalid_input",
    });
  }
  return trimmedName;
}
