/**
 * Naming the program behind a microphone stream, and skipping the ones that are not meetings
 * (volume meters, audio tools).
 */

/** Programs that read the microphone without being a call. */
const IGNORED_PROGRAMS = new Set([
  "pavucontrol", "gnome-control-center", "gnome volume control", "gnome shell volume control", "easyeffects",
  "wireplumber", "pipewire", "pulseeffects", "helvum", "qpwgraph", "cava",
]);

/** Known apps: a lowercase fragment of the binary or app name, kind and label. */
const KNOWN_APPS = [
  ["zoom", "zoom", "Zoom"],
  ["teams", "teams", "Microsoft Teams"],
  ["slack", "slack", "Slack"],
  ["discord", "discord", "Discord"],
  ["webex", "webex", "Webex"],
  ["skype", "skype", "Skype"],
  ["google chrome", "browser", "Google Chrome"],
  ["chrome", "browser", "Google Chrome"],
  ["chromium", "browser", "Chromium"],
  ["firefox", "browser", "Firefox"],
  ["brave", "browser", "Brave"],
  ["msedge", "browser", "Microsoft Edge"],
  ["microsoft edge", "browser", "Microsoft Edge"],
  ["vivaldi", "browser", "Vivaldi"],
  ["opera", "browser", "Opera"],
];

const KIND_ORDER = { browser: 1, other: 2 };

/**
 * Names the program behind a mic user, or null when it is not a meeting candidate.
 *
 * @param user - `{stream_id, app_name, binary, pid}` (object)
 * @returns `{kind, label, stream_id, pid}` or null (object|null)
 */
export function classifyMicUser(user) {
  const appName = (user.app_name ?? "").trim().toLowerCase();
  const binary = (user.binary ?? "").trim().toLowerCase();
  if (IGNORED_PROGRAMS.has(appName) || IGNORED_PROGRAMS.has(binary)) return null;
  const known = KNOWN_APPS.find(([fragment]) => binary.includes(fragment)) ?? KNOWN_APPS.find(([fragment]) => appName.includes(fragment));
  const [kind, label] = known ? [known[1], known[2]] : ["other", (user.app_name ?? "").trim() || user.binary || "A program"];
  return { kind, label, stream_id: user.stream_id, pid: user.pid ?? null };
}

/**
 * The meeting candidates among mic users, one per program, known meeting apps first.
 *
 * @param users - Mic users (Array<object>)
 * @returns Meeting apps (Array<object>)
 */
export function meetingApps(users) {
  const apps = [];
  for (const app of users.map(classifyMicUser).filter(Boolean)) {
    const isDuplicate = apps.some((seen) => seen.label === app.label && (seen.pid === app.pid || seen.pid === null));
    if (!isDuplicate) apps.push(app);
  }
  return apps.sort((left, right) => (KIND_ORDER[left.kind] ?? 0) - (KIND_ORDER[right.kind] ?? 0));
}

/**
 * "Zoom is using the microphone" / "Zoom and Google Chrome are using the microphone".
 *
 * @param apps - Meeting apps (Array<object>)
 * @returns Sentence (string)
 */
export function describeMicUsers(apps) {
  const labels = apps.map((app) => app.label);
  if (labels.length === 0) return "A program is using the microphone";
  if (labels.length === 1) return `${labels[0]} is using the microphone`;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)} are using the microphone`;
}
