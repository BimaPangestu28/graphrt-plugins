# x-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `x-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_me` | Read the authenticated X user (id, name, username). Use query_params for user.fields/expansions. | query_params |
| `get_user_by_username` | Look up an X user by username (without @). | **username**, query_params |
| `create_post` | Publish a post (tweet): text, reply, quote, media (ids from upload_media) or a poll. (as an agent tool only when X_TOOL_ALLOW_POST=1) | text, reply_to_post_id, quote_post_id, media_ids, poll_options, poll_duration_minutes, reply_settings |
| `delete_post` | Delete one of the authenticated user's posts. | **post_id** |
| `get_post` | Read a post by id. Use query_params for tweet.fields/expansions. | **post_id**, query_params |
| `list_user_posts` | List a user's posts, newest first (default: the authenticated user). | user_id, exclude, query_params, limit, cursor |
| `list_mentions` | List posts mentioning a user, newest first (default: the authenticated user). | user_id, query_params, limit, cursor |
| `search_recent_posts` | Search posts from the last 7 days with X search syntax, e.g. "from:XDevelopers -is:retweet". | **query**, sort_order, query_params, limit, cursor |
| `list_replies` | List replies in a post's conversation from the last 7 days (recent search on conversation_id). | **post_id**, sort_order, query_params, limit, cursor |
| `hide_reply` | Hide or unhide a reply to one of the authenticated user's posts. (as an agent tool only when X_TOOL_ALLOW_ENGAGE=1) | **post_id**, hidden |
| `like_post` | Like a post as the authenticated user. (as an agent tool only when X_TOOL_ALLOW_ENGAGE=1) | **post_id** |
| `unlike_post` | Remove the authenticated user's like from a post. (as an agent tool only when X_TOOL_ALLOW_ENGAGE=1) | **post_id** |
| `repost` | Repost (retweet) a post as the authenticated user. (as an agent tool only when X_TOOL_ALLOW_POST=1) | **post_id** |
| `undo_repost` | Undo the authenticated user's repost of a post. (as an agent tool only when X_TOOL_ALLOW_POST=1) | **post_id** |
| `list_dm_events` | List recent direct message events across all of the authenticated user's conversations. | event_types, query_params, limit, cursor |
| `list_dm_conversation_events` | List direct message events in one conversation, by conversation_id or by the other participant's user id. | conversation_id, participant_id, event_types, query_params, limit, cursor |
| `send_dm` | Send a direct message to a user (participant_id) or into an existing conversation (conversation_id). (as an agent tool only when X_TOOL_ALLOW_DM=1 and every recipient is in X_TOOL_RECIPIENT_ALLOWLIST) | participant_id, conversation_id, text, media_id |
| `create_group_dm` | Start a group DM conversation with 2-49 other users and send the first message. (as an agent tool only when X_TOOL_ALLOW_DM=1 and every recipient is in X_TOOL_RECIPIENT_ALLOWLIST) | **participant_ids**, text, media_id |
| `upload_media` | Download an image (https, up to 5 MB) and upload it to X. Returns data.data.id for create_post media_ids or send_dm media_id. | **image_url**, media_category |
| `refresh_access_token` | Exchange a refresh token (scope offline.access) for a new access token. X rotates refresh tokens: store the returned refresh_token. Defaults to X_REFRESH_TOKEN / X_CLIENT_ID; uses X_CLIENT_SECRET for confidential clients. | refresh_token, client_id |
| `api_request` | Call any X API endpoint that has no dedicated operation, e.g. path "/2/users/me/followers". Only the API's own host is allowed. | method, **path**, query, body |
