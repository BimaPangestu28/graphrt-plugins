/**
 * Caption operations over the official YouTube Data API v3:
 * list_caption_tracks (captions.list, 50 quota units) and get_transcript
 * (captions.download, 200 units), plus parse_captions for caption files
 * obtained another way (no network).
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { pathSegment } from "../lib/shared/path.mjs";
import { parseCaptionText } from "../lib/caption-parser.mjs";
import { parseVideoId } from "../lib/video-id.mjs";

const VIDEO_PARAMETER = { type: "string", description: "Video id (11 characters) or a youtube.com / youtu.be URL" };
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const TRACK_KIND_PREFERENCE = ["standard", "forced", "asr"];
const MAX_CHARS_PARAMETER = { type: "integer", minimum: 100, maximum: 2000000, default: 200000, description: "Longest transcript text; longer text is cut and `truncated` is true (segments are cut to match)" };

function normalizeTrack(item) {
  const snippet = item.snippet ?? {};
  return {
    id: item.id,
    language: snippet.language ?? null,
    name: snippet.name ?? "",
    track_kind: snippet.trackKind ?? null,
    is_cc: snippet.isCC ?? false,
    is_auto_synced: snippet.isAutoSynced ?? false,
    is_draft: snippet.isDraft ?? false,
    status: snippet.status ?? null,
    last_updated: snippet.lastUpdated ?? null,
  };
}

function validateLanguage(language, parameterName) {
  if (language !== undefined && !LANGUAGE_PATTERN.test(language)) throw new PluginError(`\`${parameterName}\` must be a language code such as en or pt-BR`, { kind: "invalid_input" });
  return language;
}

async function listTracks(client, videoId, signal) {
  const body = await client.request({ path: "/captions", query: { part: "snippet", videoId }, signal });
  return (body?.items ?? []).map(normalizeTrack);
}

/**
 * Picks the best published track: in `language` when given, standard before forced before auto-generated.
 *
 * @param tracks - Normalised tracks (object[])
 * @param language - Wanted language code (string, optional)
 * @returns The chosen track (object)
 * @throws PluginError kind `not_found` - When no published track matches, naming the languages there are
 */
export function pickTrack(tracks, language) {
  const published = tracks.filter((track) => !track.is_draft);
  const wanted = language ? language.toLowerCase() : null;
  const matching = published.filter((track) => !wanted || track.language?.toLowerCase() === wanted || track.language?.toLowerCase().startsWith(`${wanted}-`));
  const ranked = [...matching].sort((left, right) => rankKind(left) - rankKind(right));
  if (ranked[0]) return ranked[0];
  const languages = [...new Set(published.map((track) => track.language).filter(Boolean))].sort();
  throw new PluginError(`No published caption track${language ? ` in ${language}` : ""} for this video${languages.length ? ` (available: ${languages.join(", ")})` : ""}`, { kind: "not_found" });
}

function rankKind(track) {
  const rank = TRACK_KIND_PREFERENCE.indexOf(track.track_kind);
  return rank === -1 ? TRACK_KIND_PREFERENCE.length : rank;
}

/**
 * Cuts a parsed transcript so that neither the text nor the segments hold more than `maxChars` characters
 * (rolling auto-captions repeat lines, so the segments can be much longer than the deduplicated text).
 *
 * @param parsed - `{segments, text}` from parseCaptionText (object)
 * @param maxChars - Limit (number)
 * @returns `{segments, text, truncated}`; truncated is true when either was cut (object)
 */
export function capTranscript(parsed, maxChars) {
  const isTextCut = parsed.text.length > maxChars;
  const text = isTextCut ? `${parsed.text.slice(0, maxChars).trimEnd()}…` : parsed.text;
  const segments = [];
  let usedCharacters = 0;
  for (const segment of parsed.segments) {
    if (usedCharacters + segment.text.length > maxChars) break;
    usedCharacters += segment.text.length;
    segments.push(segment);
  }
  return { segments, text, truncated: isTextCut || segments.length < parsed.segments.length };
}

function assertCaptionSize(client, content) {
  if (Buffer.byteLength(content) > client.settings.maxCaptionBytes) {
    throw new PluginError(`\`content\` is larger than the ${client.settings.maxCaptionBytes}-byte limit (YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES)`, { kind: "invalid_input" });
  }
}

// captions.download answers 403 "forbidden" for videos the account cannot edit; say so only for that call.
async function downloadWithHint(client, request) {
  try {
    return await client.downloadCaption(request);
  } catch (downloadError) {
    if (downloadError?.kind !== "permission_denied" || !/reason forbidden/.test(downloadError.message)) throw downloadError;
    throw new PluginError(`${downloadError.message}. captions.download only works for videos the authorised account can edit.`, { kind: "permission_denied" });
  }
}

async function chooseTrack(client, args, signal) {
  if (args.caption_id) return { videoId: null, track: { id: args.caption_id } };
  if (!args.video) throw new PluginError("Pass `video` (and optionally `language`) or `caption_id`", { kind: "invalid_input" });
  const videoId = parseVideoId(args.video);
  return { videoId, track: pickTrack(await listTracks(client, videoId, signal), validateLanguage(args.language, "language")) };
}

const listCaptionTracksOperation = {
  name: "list_caption_tracks",
  title: "List caption tracks",
  description: "Lists a video's caption tracks (id, language, name, standard or auto-generated, draft, status) with the official YouTube Data API (OAuth; 50 quota units)",
  parameters: { type: "object", properties: { video: VIDEO_PARAMETER }, required: ["video"] },
  run: async ({ client, args, signal }) => {
    const videoId = parseVideoId(args.video);
    return { data: { video_id: videoId, tracks: await listTracks(client, videoId, signal) } };
  },
};

const getTranscriptOperation = {
  name: "get_transcript",
  title: "Get a transcript",
  description: "Downloads a caption track with the official YouTube Data API (captions.download, OAuth, 200 quota units; only for videos the authorised account can edit) and returns timed segments and plain text, or the raw file",
  parameters: {
    type: "object",
    properties: {
      video: { ...VIDEO_PARAMETER, description: "Video id (11 characters) or a youtube.com / youtu.be URL; required unless caption_id is given" },
      language: { type: "string", description: "Track language, e.g. en (default: the best published track); standard tracks are preferred over auto-generated ones" },
      caption_id: { type: "string", description: "A track id from list_caption_tracks; skips the listing (`video` is then not needed and the result's video_id is null, since the track's video is not checked)" },
      translate_to: { type: "string", description: "Language code for a machine translation by YouTube (tlang)" },
      format: { type: "string", enum: ["segments", "vtt", "srt", "ttml", "sbv"], default: "segments", description: "segments: parsed segments and text; otherwise the caption file as returned" },
      max_chars: MAX_CHARS_PARAMETER,
    },
  },
  run: async ({ client, args, signal }) => {
    const translateTo = validateLanguage(args.translate_to, "translate_to");
    const { videoId, track } = await chooseTrack(client, args, signal);
    const fileFormat = args.format === "segments" ? "vtt" : args.format;
    const captionFile = await downloadWithHint(client, { path: `/captions/${pathSegment(track.id)}`, query: { tfmt: fileFormat, ...(translateTo ? { tlang: translateTo } : {}) }, signal });
    const base = { video_id: videoId, track, translated_to: translateTo ?? null };
    if (args.format !== "segments") return { data: { ...base, format: args.format, caption_file: captionFile } };
    return { data: { ...base, format: "segments", ...capTranscript(parseCaptionText(captionFile), args.max_chars) } };
  },
};

const parseCaptionsOperation = {
  name: "parse_captions",
  title: "Parse a caption file",
  description: "Parses WebVTT or SRT caption text you already have into timed segments and plain transcript text (no network, no credentials)",
  parameters: {
    type: "object",
    properties: { content: { type: "string", description: "WebVTT or SRT file contents (at most YOUTUBE_TRANSCRIPT_MAX_CAPTION_BYTES, default 5 MiB)" }, max_chars: MAX_CHARS_PARAMETER },
    required: ["content"],
  },
  run: async ({ client, args }) => {
    assertCaptionSize(client, args.content);
    return { data: capTranscript(parseCaptionText(args.content), args.max_chars) };
  },
};

export const captionOperations = [listCaptionTracksOperation, getTranscriptOperation, parseCaptionsOperation];
