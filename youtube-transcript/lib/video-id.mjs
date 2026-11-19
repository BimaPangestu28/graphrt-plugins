/**
 * Extracts an 11-character YouTube video id from an id or a youtube.com /
 * youtu.be URL. Only YouTube's own hosts are accepted, so a URL can never send
 * the plugin anywhere else.
 */
import { PluginError } from "./shared/graphrt-plugin.mjs";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const PATH_PREFIXES = ["/shorts/", "/embed/", "/live/", "/v/"];

/**
 * Returns the video id from an id or URL.
 *
 * @param input - Video id or URL (string)
 * @returns 11-character video id (string)
 * @throws PluginError kind `invalid_input` - When no valid id can be found
 *
 * @example
 * parseVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc"); // "dQw4w9WgXcQ"
 */
export function parseVideoId(input) {
  const trimmed = String(input ?? "").trim();
  if (VIDEO_ID_PATTERN.test(trimmed)) return trimmed;
  const candidate = extractFromUrl(trimmed);
  if (candidate && VIDEO_ID_PATTERN.test(candidate)) return candidate;
  throw new PluginError(`\`video\` must be an 11-character YouTube video id or a youtube.com / youtu.be video URL, got ${JSON.stringify(trimmed.slice(0, 200))}`, { kind: "invalid_input" });
}

function extractFromUrl(text) {
  let parsedUrl;
  try {
    parsedUrl = new URL(text);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") return null;
  const host = parsedUrl.hostname.toLowerCase();
  if (host === "youtu.be") return parsedUrl.pathname.slice(1);
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (parsedUrl.pathname === "/watch") return parsedUrl.searchParams.get("v");
  const prefix = PATH_PREFIXES.find((pathPrefix) => parsedUrl.pathname.startsWith(pathPrefix));
  return prefix ? parsedUrl.pathname.slice(prefix.length).replace(/\/$/, "") : null;
}
