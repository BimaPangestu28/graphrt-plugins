/**
 * youtube-api plugin definition: the authenticated YouTube channel, its videos,
 * comments and live chat through the YouTube Data API v3.
 */
import { createYouTubeClient } from "./lib/client.mjs";
import { resolveYouTubeCredentials } from "./lib/oauth.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { commentOperations } from "./operations/comments.mjs";
import { liveChatOperations } from "./operations/live-chat.mjs";
import { videoOperations } from "./operations/videos.mjs";

export const pluginDefinition = {
  name: "youtube-api",
  version: "0.2.0",
  description: "YouTube channel, videos, comments and live chat via the official YouTube Data API v3",
  toolUserToken: { credentialEnv: ["YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"] },
  tokenEnv: "YOUTUBE_ACCESS_TOKEN",
  extraEnv: ["YOUTUBE_REFRESH_TOKEN", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"],
  resolveAccessToken: resolveYouTubeCredentials,
  createClient: createYouTubeClient,
  operations: [
    ...videoOperations,
    ...commentOperations,
    ...liveChatOperations,
    createApiRequestOperation({ apiName: "YouTube Data API", examplePath: "/playlists" }),
  ],
};
