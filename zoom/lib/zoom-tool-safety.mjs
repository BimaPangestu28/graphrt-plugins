/**
 * Agent-tool safety for the zoom plugin.
 *
 * - Bearer-like links and passcodes never reach agent tools: `start_url` (starts the meeting as the host, carries a
 *   ZAK token), recording `download_url`/`play_url`/`share_url`, `download_access_token`, and every passcode field.
 *   `join_url` is kept: it is the link meant for participants. Workflow nodes get the full response.
 * - `api_request` as a tool may only GET an allowlist of read paths. Zoom has secret-bearing GET endpoints (e.g.
 *   `/users/{userId}/token` returns a ZAK host token), so a denylist is not enough.
 * - Meeting UUIDs that start with "/" or contain "//" must be double-encoded in paths
 *   (https://developers.zoom.us/docs/api/meetings/): `prepareMeetingUuid` encodes them once and the declarative
 *   layer encodes the path segment again.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const BEARER_FIELDS = new Set([
  "start_url",
  "download_url",
  "play_url",
  "share_url",
  "download_access_token",
  "token",
  "password",
  "encrypted_password",
  "h323_password",
  "pstn_password",
  "recording_play_passcode",
]);

// Matched against the path decoded once. User ids and webinar ids may not contain "%" (nothing left encoded);
// meeting UUIDs may, because Zoom wants some of them double-encoded. Registrants are not listed: each registrant's
// join_url is a personal join link.
const USER = "[^/%]+";
const MEETING = "[^/]+";
const TOOL_READ_PATHS = [
  /^\/users$/,
  new RegExp(`^/users/${USER}$`),
  new RegExp(`^/users/${USER}/(meetings|upcoming_meetings|recordings|webinars)$`),
  new RegExp(`^/meetings/${MEETING}$`),
  new RegExp(`^/meetings/${MEETING}/(recordings|polls|meeting_summary)$`),
  new RegExp(`^/past_meetings/${MEETING}$`),
  new RegExp(`^/past_meetings/${MEETING}/(participants|instances|polls|qa)$`),
  new RegExp(`^/report/users/${USER}/meetings$`),
  new RegExp(`^/report/meetings/${MEETING}(/participants)?$`),
  new RegExp(`^/webinars/${USER}$`),
  /^\/meeting_summaries$/,
];
// An encoded slash or backslash could turn one allowed segment into several on Zoom's side (`/users/me%2Ftoken`).
const ENCODED_SEPARATOR = /%2f|%5c|\\/i;

/**
 * Removes bearer-like links and passcodes from a response, at any depth.
 *
 * @param value - Response data (any)
 * @returns A copy without those fields (any)
 *
 * @example
 * stripBearerFields({ topic: "Sync", start_url: "https://zoom.us/s/1?zak=..." }); // { topic: "Sync" }
 */
export function stripBearerFields(value) {
  if (Array.isArray(value)) return value.map(stripBearerFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([fieldName]) => !BEARER_FIELDS.has(fieldName)).map(([fieldName, fieldValue]) => [fieldName, stripBearerFields(fieldValue)]));
}

/**
 * Whether an api_request path is one of the read paths agent tools may call.
 *
 * @param path - api_request `path`, e.g. "/users/me/meetings?type=upcoming" (string)
 * @returns True when allowed (boolean)
 */
export function isZoomToolReadPath(path) {
  const rawPathname = String(path).split(/[?#]/)[0];
  if (ENCODED_SEPARATOR.test(rawPathname)) return false;
  const pathname = decodeOrNull(rawPathname)?.toLowerCase();
  if (!pathname || pathname.includes("//") || pathname.includes("\\")) return false;
  if (pathname.split("/").slice(1).some(isDotSegment)) return false;
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return TOOL_READ_PATHS.some((pattern) => pattern.test(normalizedPath));
}

// A segment that is (or, decoded once more, becomes) "." or ".." — double-encoded meeting UUIDs are decoded again.
function isDotSegment(segment) {
  const decodedAgain = decodeOrNull(segment);
  return [".", ".."].includes(segment) || decodedAgain === null || [".", ".."].includes(decodedAgain) || decodedAgain.includes("../") || decodedAgain.includes("\\");
}

function decodeOrNull(text) {
  try {
    return decodeURIComponent(text);
  } catch (decodeError) {
    if (decodeError instanceof URIError) return null;
    throw decodeError;
  }
}

/**
 * Prepares a meeting id or UUID for a path segment: UUIDs that start with "/" or contain "//" are encoded once
 * here, so the path is double-encoded as Zoom requires.
 *
 * @param meetingId - Meeting id or UUID (string | number)
 * @returns The value to put in the path (string | number)
 */
export function prepareMeetingUuid(meetingId) {
  if (typeof meetingId !== "string") return meetingId;
  return meetingId.startsWith("/") || meetingId.includes("//") ? encodeURIComponent(meetingId) : meetingId;
}

/**
 * Wraps the generated api_request so tool calls may only reach the read allowlist.
 *
 * @param apiRequestOperation - Generated api_request operation (object)
 * @returns Operation with a guarded run (object)
 */
export function restrictApiRequestForTools(apiRequestOperation) {
  return {
    ...apiRequestOperation,
    description: `${apiRequestOperation.description} Agent tools may only read users, meetings, past meetings, recordings and reports (start links, recording download links and passcodes are removed).`,
    run: (context) => {
      if (context.source === "tool" && !isZoomToolReadPath(context.args?.path ?? "")) {
        throw new PluginError("api_request as an agent tool may only GET Zoom user, meeting, past-meeting, recording and report paths (e.g. /users/me/token returns a host token); use a workflow node for other paths", { kind: "permission_denied" });
      }
      return apiRequestOperation.run(context);
    },
  };
}
