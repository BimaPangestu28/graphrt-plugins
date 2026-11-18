# TikTok APIs research (2026-11-18)
## Open API (open.tiktokapis.com) — Bearer token (2h; refresh 180d, rotating)
- POST /v2/oauth/token/ form grant_type=refresh_token, refresh_token, client_key, client_secret
- GET /v2/user/info/?fields=open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,username,follower_count,following_count,likes_count,video_count
- POST /v2/video/list/?fields=... {cursor, max_count≤20} → data{videos[],cursor,has_more}
- POST /v2/video/query/?fields=... {filters{video_ids[≤20]}}
- POST /v2/post/publish/creator_info/query/ → data{privacy_level_options[],...}
- POST /v2/post/publish/video/init/ {post_info{title,privacy_level,disable_comment,disable_duet,disable_stitch,video_cover_timestamp_ms,brand_content_toggle,brand_organic_toggle,is_aigc}, source_info{source:PULL_FROM_URL,video_url}} → data{publish_id}
- POST /v2/post/publish/inbox/video/init/ {source_info} → publish_id
- POST /v2/post/publish/content/init/ {media_type:PHOTO, post_mode DIRECT_POST|MEDIA_UPLOAD, post_info{title,description,privacy_level,disable_comment,auto_add_music}, source_info{source:PULL_FROM_URL, photo_images[], photo_cover_index}}
- POST /v2/post/publish/status/fetch/ {publish_id} → status PROCESSING_UPLOAD|PROCESSING_DOWNLOAD|SEND_TO_USER_INBOX|PUBLISH_COMPLETE|FAILED, fail_reason, publicaly_available_post_id
- Errors {data, error{code:"ok"|..., message, log_id}}; OAuth errors {error, error_description}. 429 rate_limit_exceeded.
- Unaudited apps: SELF_ONLY posts. PULL_FROM_URL needs verified domain.
## Business API (business-api.tiktok.com/open_api/v1.3) — header Access-Token, business_id = open_id
- GET /business/comment/list/ business_id, video_id, include_replies, status PUBLIC|HIDDEN|ALL, sort_field, sort_type, cursor, max_count
- GET /business/comment/reply/list/ business_id, video_id, comment_id
- POST /business/comment/create/ {business_id, video_id, text}; /business/comment/reply/create/ {+comment_id}; /business/comment/hide/ {business_id, comment_id, action HIDE|UNHIDE}; /business/comment/like/ {action LIKE|UNLIKE}; /business/comment/delete/ {business_id, comment_id}
- Messaging (restricted): POST /business/message/send/ {business_id, recipient_type, recipient, message_type, text}; GET /business/message/conversation/list/ business_id, conversation_type, limit, cursor; GET /business/message/content/list/
- Responses {code:0, message, request_id, data}; non-zero code = error. Field names from third-party Go client — unverified.
