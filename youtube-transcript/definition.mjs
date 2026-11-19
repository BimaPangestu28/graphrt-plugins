/**
 * youtube-transcript plugin definition: caption tracks and transcripts through
 * the official YouTube Data API v3 only.
 *
 * Deliberately no scraping: YouTube's Terms of Service forbid automated access
 * outside the documented API, and the unofficial timedtext/innertube endpoints
 * change without notice (see README). Credentials are the same as youtube-api's
 * (the OAuth module is a copy) and never reach an LLM.
 */
import { createCaptionsClient, MAX_CAPTION_BYTES_VARIABLE, resolveCredentialsLazily } from "./lib/client.mjs";
import { captionOperations } from "./operations/captions.mjs";

export const pluginDefinition = {
  name: "youtube-transcript",
  version: "0.1.0",
  description: "YouTube captions via the official Data API: list a video's caption tracks and download one as timed segments and plain text (videos you can edit), or parse VTT/SRT you already have",
  tokenEnv: "YOUTUBE_ACCESS_TOKEN",
  extraEnv: ["YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", MAX_CAPTION_BYTES_VARIABLE],
  resolveAccessToken: resolveCredentialsLazily,
  createClient: createCaptionsClient,
  limits: { timeout_ms: 120000, max_concurrency: 4 },
  operations: captionOperations,
};
