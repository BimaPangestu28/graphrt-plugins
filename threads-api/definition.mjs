/**
 * threads-api plugin definition: profile, posts, publishing and reply
 * moderation through the official Threads API.
 */
import { createThreadsClient } from "./lib/client.mjs";
import { createApiRequestOperation } from "./lib/shared/api-request-operation.mjs";
import { postOperations } from "./operations/posts.mjs";
import { profileOperations } from "./operations/profile.mjs";
import { publishOperations } from "./operations/publish.mjs";
import { replyOperations } from "./operations/replies.mjs";

export const pluginDefinition = {
  name: "threads-api",
  version: "0.2.0",
  description: "Threads profiles, posts, publishing, replies, mentions and search via the official Threads API",
  tokenEnv: "THREADS_ACCESS_TOKEN",
  extraEnv: [],
  // Publishing can wait up to 5 minutes per container, plus carousel children.
  limits: { timeout_ms: 420000 },
  createClient: createThreadsClient,
  operations: [
    ...profileOperations,
    ...postOperations,
    ...publishOperations,
    ...replyOperations,
    createApiRequestOperation({ apiName: "Threads API", examplePath: "/me/threads_insights" }),
  ],
};
