# tiktok-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `tiktok-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_user_info` | Read the authorized TikTok user's profile (display name, username, follower and video counts). Fields need the matching user.info.* scopes. | fields |
| `list_videos` | List the authorized user's public videos, newest first (scope video.list). | fields, limit, cursor |
| `query_videos` | Read specific videos of the authorized user by id (up to 20), e.g. to refresh their counts. | **video_ids**, fields |
| `get_creator_info` | Read the creator's posting settings: allowed privacy levels, whether comments/duet/stitch are disabled, and max video duration. |  |
| `refresh_access_token` | Exchange a refresh token for a new access token. TikTok rotates refresh tokens: store the returned refresh_token. The client secret is read from TIKTOK_CLIENT_SECRET only. | refresh_token, client_key |
| `publish_video` | Post a video from a public URL on a verified domain. mode=direct posts it (needs privacy_level); mode=inbox sends it to the creator's TikTok inbox as a draft to finish in the app. | **video_url**, mode, title, privacy_level, disable_comment, disable_duet, disable_stitch, video_cover_timestamp_ms, brand_content_toggle, brand_organic_toggle, is_aigc, wait |
| `publish_photos` | Post 1-35 photos from public URLs on a verified domain. mode=direct posts them (needs privacy_level); mode=upload sends them to the creator's inbox to finish in the app. | **photo_urls**, mode, title, description, privacy_level, photo_cover_index, disable_comment, auto_add_music, wait |
| `get_publish_status` | Read the status of a publish_id (PROCESSING_UPLOAD, PROCESSING_DOWNLOAD, SEND_TO_USER_INBOX, PUBLISH_COMPLETE or FAILED). | **publish_id** |
| `list_comments` | List comments on one of the business account's videos (Business API). | business_id, **video_id**, status, include_replies, sort_field, sort_type, limit, cursor |
| `list_comment_replies` | List replies to a comment on the business account's video (Business API). | business_id, **video_id**, **comment_id**, limit, cursor |
| `create_comment` | Post a comment on one of the business account's videos (Business API). | business_id, **video_id**, **text** |
| `reply_to_comment` | Reply to a comment on one of the business account's videos (Business API). | business_id, **video_id**, **comment_id**, **text** |
| `set_comment_hidden` | Hide or unhide a comment on the business account's video (Business API). | business_id, **comment_id**, **hidden**, video_id |
| `set_comment_liked` | Like or unlike a comment as the business account (Business API). | business_id, **comment_id**, **liked** |
| `delete_comment` | Delete a comment the business account owns or that is on its video (Business API). | business_id, **comment_id** |
| `list_conversations` | List direct-message conversations of the business account (Business API; restricted access). | business_id, conversation_type, limit, cursor |
| `list_messages` | List messages in one direct-message conversation (Business API; restricted access). | business_id, **conversation_id**, conversation_type, cursor |
| `send_message` | Send a text direct message as the business account (Business API; restricted access, only within 48 hours of the user's last message). | business_id, **recipient**, recipient_type, **text** |
| `api_request` | Call any TikTok API endpoint that has no dedicated operation, e.g. path "/v2/user/info/". Only the API's own host is allowed. | method, **path**, query, body, api |
