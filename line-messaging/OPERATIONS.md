# line-messaging operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `line-messaging.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `get_bot_info` | The bot's user id, basic id, display name, picture and chat mode |  |
| `get_profile` | Display name, picture, status message and language of a user who added the bot | **user_id** |
| `list_followers` | User ids of the bot's friends (verified or premium accounts only) | cursor, limit |
| `get_group_summary` | Name and picture of a group the bot is in | **group_id** |
| `get_group_member_count` | Number of users in a group | **group_id** |
| `get_group_member_profile` | Profile of a member of a group the bot is in | **group_id**, **user_id** |
| `get_quota` | This month's message limit (type none means unlimited) |  |
| `get_quota_consumption` | Messages sent this month that count toward the quota |  |
| `get_push_message_count` | Number of push messages sent on a day (status ready, unready or out_of_service) | **date** |
| `validate_push_messages` | Check message objects for a push without sending them (free) | **messages** |
| `push_message` | Send up to 5 messages to one user, group or room at any time (counts toward the monthly quota) (as an agent tool only when LINE_TOOL_ALLOW_SEND=1) | **to**, **messages**, notification_disabled |
| `reply_message` | Reply to a webhook event with its reply token (one use, valid for a short time; replies are free) (as an agent tool only when LINE_TOOL_ALLOW_SEND=1) | **reply_token**, **messages**, notification_disabled |
| `multicast_message` | Send the same messages to up to 500 user ids (each recipient counts toward the quota) | **to**, **messages**, notification_disabled |
| `broadcast_message` | Send messages to every friend of the bot (each recipient counts toward the quota) | **messages**, notification_disabled |
| `show_loading_animation` | Show a typing/loading indicator in a one-on-one chat while the bot prepares a reply | **chat_id**, loading_seconds |
| `api_request` | Call any LINE Messaging API endpoint that has no dedicated operation, e.g. path "/v2/bot/info". Only the API's own host is allowed. | method, **path**, query, body |
