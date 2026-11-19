# threads-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `threads-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_profile` | Read the authenticated Threads profile (id, username, name, bio, picture, verification). | fields |
| `lookup_profile` | Look up a public Threads profile by username (needs threads_profile_discovery). | **username** |
| `get_publishing_limit` | Read the account's 24-hour quota usage for posts, replies and deletes. |  |
| `refresh_access_token` | Exchange the current long-lived token (at least 24 hours old, not expired) for a new 60-day token. Returns {access_token, token_type, expires_in}; store the new token yourself. |  |
| `list_threads` | List threads published by the account (or another user id the token can read), newest first. | user_id, fields, since, until, limit, cursor |
| `list_my_replies` | List replies the account has posted, newest first. | fields, since, until, limit, cursor |
| `list_mentions` | List public posts that mention the account (needs threads_manage_mentions). | fields, since, until, limit, cursor |
| `keyword_search` | Search public Threads posts by keyword or topic tag (needs threads_keyword_search). | **q**, search_type, search_mode, fields, since, until, limit, cursor |
| `repost_thread` | Repost a Threads post to the account's profile. Returns the repost id. (as an agent tool only when THREADS_TOOL_ALLOW_POST=1) | **media_id** |
| `delete_thread` | Delete one of the account's Threads posts or replies (needs threads_delete). | **media_id** |
| `publish_thread` | Publish a Threads post: TEXT, IMAGE, VIDEO or CAROUSEL (2-20 items) from public media URLs, optionally as a reply or quote, with a poll, link, topic tag or reply controls. Waits for Threads to process the media (up to 6 minutes). If publishing fails after the container was made, retry with `existing_container_id` instead of re-running, so nothing is posted twice. (as an agent tool only when THREADS_TOOL_ALLOW_POST=1) | media_type, text, image_url, video_url, alt_text, carousel_items, reply_to_id, quote_post_id, reply_control, poll_options, link_attachment, topic_tag, existing_container_id |
| `list_replies` | List replies to a Threads post. With conversation=true, list every reply at every depth in the conversation instead of only top-level replies. | **media_id**, fields, reverse, limit, cursor, conversation |
| `hide_reply` | Hide or unhide a reply under one of the account's posts (needs threads_manage_replies). (as an agent tool only when THREADS_TOOL_ALLOW_ENGAGE=1) | **reply_id**, **hidden** |
| `list_pending_replies` | List replies awaiting approval on a post that uses reply approvals. | **media_id**, fields, reverse, limit, cursor, approval_status |
| `approve_pending_reply` | Approve (approve=true) or ignore (approve=false) a pending reply. (as an agent tool only when THREADS_TOOL_ALLOW_ENGAGE=1) | **reply_id**, **approve** |
| `api_request` | Call any Threads API endpoint that has no dedicated operation, e.g. path "/me/threads_insights". Only the API's own host is allowed. | method, **path**, query, body |
