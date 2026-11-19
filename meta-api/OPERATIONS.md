# meta-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `meta-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_page` | Read Facebook Page details (name, category, followers, linked Instagram account). | page_id, fields |
| `list_page_posts` | List posts on the Facebook Page feed, newest first. | page_id, fields, limit, cursor |
| `create_page_post` | Publish (or schedule) a text and/or link post on the Facebook Page. (as an agent tool only when META_TOOL_ALLOW_POST=1) | page_id, message, link, published, scheduled_publish_time |
| `create_page_photo_post` | Publish a photo post on the Facebook Page from a public image URL. (as an agent tool only when META_TOOL_ALLOW_POST=1) | page_id, **image_url**, message, published |
| `update_page_post` | Edit the text of a Page post this app created. (as an agent tool only when META_TOOL_ALLOW_POST=1) | **post_id**, **message** |
| `delete_page_post` | Delete a Page post. | **post_id** |
| `list_comments` | List comments on a Page post, photo or comment (use a comment id to list its replies). | **object_id**, filter, order, fields, limit, cursor |
| `reply_to_comment` | Comment on a Page post or reply to a comment as the Page. (as an agent tool only when META_TOOL_ALLOW_POST=1) | **object_id**, **message**, attachment_url |
| `set_comment_hidden` | Hide or unhide a comment on the Page. (as an agent tool only when META_TOOL_ALLOW_ENGAGE=1) | **comment_id**, **hidden** |
| `delete_comment` | Delete a comment on the Page. | **comment_id** |
| `like_comment` | Like a comment as the Page. (as an agent tool only when META_TOOL_ALLOW_ENGAGE=1) | **comment_id** |
| `unlike_comment` | Remove the Page's like from a comment. (as an agent tool only when META_TOOL_ALLOW_ENGAGE=1) | **comment_id** |
| `get_instagram_account` | Read the Instagram professional account (username, followers, media count). | ig_user_id, fields |
| `list_instagram_media` | List the account's posts, reels and carousels, newest first. | ig_user_id, fields, limit, cursor |
| `get_instagram_publishing_limit` | Read how many posts the account published in the last 24 hours and its quota. | ig_user_id |
| `publish_instagram_media` | Publish an image, reel (VIDEO is published as REELS), story or carousel from public media URLs. Waits for Instagram to process the media (up to 6 minutes in total). (as an agent tool only when META_TOOL_ALLOW_POST=1) | ig_user_id, media_type, image_url, video_url, caption, alt_text, share_to_feed, carousel_items |
| `list_instagram_comments` | List comments on an Instagram media item. | **media_id**, fields, limit, cursor |
| `list_instagram_comment_replies` | List replies to an Instagram comment. | **comment_id**, fields, limit, cursor |
| `reply_to_instagram_comment` | Reply to a comment on the account's Instagram media. (as an agent tool only when META_TOOL_ALLOW_POST=1) | **comment_id**, **message** |
| `set_instagram_comment_hidden` | Hide or unhide a comment on the account's Instagram media. (as an agent tool only when META_TOOL_ALLOW_ENGAGE=1) | **comment_id**, **hidden** |
| `delete_instagram_comment` | Delete a comment on the account's Instagram media. | **comment_id** |
| `list_conversations` | List the Page's Messenger or Instagram Direct conversations, optionally for one person. | page_id, platform, user_id, fields, limit, cursor |
| `list_conversation_messages` | List messages in a Messenger or Instagram Direct conversation, newest first. | **conversation_id**, fields, limit, cursor |
| `send_message` | Send a Messenger or Instagram Direct message from the Page to a PSID/IGSID. Free-form only within 24 h of their last message; otherwise use MESSAGE_TAG + HUMAN_AGENT. (as an agent tool only when META_TOOL_ALLOW_DM=1 and the recipient is in META_TOOL_RECIPIENT_ALLOWLIST) | page_id, **recipient_id**, text, attachment_url, attachment_type, messaging_type, tag, reply_to_message_id |
| `api_request` | Call any Meta Graph API endpoint that has no dedicated operation, e.g. path "/me/accounts". Only the API's own host is allowed. | method, **path**, query, body |
