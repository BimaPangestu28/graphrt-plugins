/**
 * The one AppleScript this plugin runs, and the osascript argument array.
 *
 * Injection-proof by construction: the script is a constant, and the
 * notification's text is passed as separate process arguments after `--`
 * (so a value such as `-e` is never read as an osascript option). AppleScript
 * receives them in `argv` as plain strings; they are never pasted into script
 * source, so no quoting or escaping is involved and none can be broken.
 */

/** The fixed script: argv is message, title, subtitle, sound name ("" for none). */
export const NOTIFICATION_SCRIPT_LINES = [
  "on run argv",
  "set notificationMessage to item 1 of argv",
  "set notificationTitle to item 2 of argv",
  "set notificationSubtitle to item 3 of argv",
  "set soundName to item 4 of argv",
  "if soundName is \"\" then",
  "display notification notificationMessage with title notificationTitle subtitle notificationSubtitle",
  "else",
  "display notification notificationMessage with title notificationTitle subtitle notificationSubtitle sound name soundName",
  "end if",
  "end run",
];

/**
 * Builds osascript's arguments: each script line as `-e <line>`, then `--`, then the values.
 *
 * @param scriptLines - Constant script lines (string[])
 * @param values - Values for the script's argv (string[])
 * @returns Argument array for /usr/bin/osascript (string[])
 *
 * @example
 * buildOsascriptArguments(["on run argv", "return item 1 of argv", "end run"], ["hi"]);
 * // ["-e", "on run argv", "-e", "return item 1 of argv", "-e", "end run", "--", "hi"]
 */
export function buildOsascriptArguments(scriptLines, values) {
  return [...scriptLines.flatMap((line) => ["-e", line]), "--", ...values];
}
