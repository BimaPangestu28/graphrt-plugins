# youtube-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `youtube-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_my_channel` | Read the authenticated user's channel (title, statistics, uploads playlist id). | part |
| `list_my_videos` | List the authenticated channel's uploads, newest first. Pass `uploads_playlist_id` (returned in data) to skip the channel lookup. | uploads_playlist_id, part, limit, cursor |
| `get_videos` | Read details of up to 50 videos by id (snippet, status, statistics, duration). | **video_ids**, part |
| `update_video_metadata` | Change a video's title, description, tags or category. Reads the current snippet first, so fields you omit keep their values. | **video_id**, video_title, description, clear_description, tags, category_id |
| `delete_video` | Permanently delete one of the authenticated channel's videos. | **video_id** |
| `list_comment_threads` | List top-level comments (with some replies) on a video, or on all of a channel's videos. Filter by search terms or moderation status. | video_id, channel_id, order, search_terms, moderation_status, text_format, part, limit, cursor |
| `list_comment_replies` | List all replies to a top-level comment. | **parent_id**, text_format, limit, cursor |
| `post_comment` | Post a new top-level comment on a video. | **video_id**, **text**, channel_id |
| `reply_to_comment` | Reply to a top-level comment. | **parent_id**, **text** |
| `update_comment` | Change the text of a comment the authenticated user wrote. | **comment_id**, **text** |
| `delete_comment` | Delete a comment the authenticated user wrote. | **comment_id** |
| `set_comment_moderation_status` | Publish, hold for review or reject up to 50 comments on your channel; optionally ban the author when rejecting. | **comment_ids**, **moderation_status**, ban_author |
| `list_live_chat_messages` | Read live chat messages. Pass next_cursor back to get only newer messages, waiting polling_interval_ms between calls. Costs 5 quota units per call. | live_chat_id, video_id, part, limit, cursor |
| `send_live_chat_message` | Post a text message to a live chat as the authenticated channel. | live_chat_id, video_id, **text** |
| `api_request` | Call any YouTube Data API endpoint that has no dedicated operation, e.g. path "/playlists". Only the API's own host is allowed. | method, **path**, query, body |
