# google-business-profile-api operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `google-business-profile-api.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `list_accounts` | List the Business Profile accounts (personal, location groups, organizations) the credentials can access. | parent_account, account_type, limit, cursor |
| `list_locations` | List an account's locations (businesses) with title, address, phone, website and Maps ids. Location `name` is locations/{id}. | **account_id**, read_mask, filter, order_by, limit, cursor |
| `get_location` | Get one location's details: profile description, phones, categories, address, regular and special hours. | **location_id**, read_mask |
| `update_location` | Update only the given fields of a location: description, primary/additional phones, regular hours (replaces all periods) and special hours (replaces all). Times are HH:MM, dates YYYY-MM-DD. Safe to resend after a failure. | **location_id**, description, primary_phone, additional_phones, regular_hours, special_hours, validate_only |
| `list_reviews` | List a verified location's reviews, newest first by default, with the average rating and total count. | **account_id**, **location_id**, order_by, limit, cursor |
| `get_review` | Get one review with its star rating, comment and the owner's reply. | **account_id**, **location_id**, **review_id** |
| `reply_to_review` | Post the owner's public reply to a review, or replace the existing reply. | **account_id**, **location_id**, **review_id**, **comment** |
| `delete_review_reply` | Delete the owner's reply to a review. | **account_id**, **location_id**, **review_id** |
| `list_local_posts` | List a location's posts (updates, events, offers), newest first. | **account_id**, **location_id**, limit, cursor |
| `create_local_post` | Publish a post on a location's Business Profile: STANDARD (update), EVENT or OFFER, with an optional button and photo URL. Never retried after an unknown outcome: check list_local_posts first. | **account_id**, **location_id**, topic_type, summary, language_code, call_to_action_type, call_to_action_url, media_url, media_format, event_title, event_start, event_end, offer_coupon_code, offer_redeem_url, offer_terms |
| `delete_local_post` | Delete a post from a location's Business Profile. | **account_id**, **location_id**, **local_post_id** |
| `get_daily_metrics` | Daily performance of a location between two dates: impressions (Maps/Search, desktop/mobile), calls, website clicks, directions, messages, bookings. | **location_id**, **start_date**, **end_date**, metrics |
| `api_request` | Call any Google Business Profile API endpoint that has no dedicated operation, e.g. path "/accounts/{account_id}/locations/{location_id}/media". Only the API's own host is allowed. | method, **path**, query, body, host |
