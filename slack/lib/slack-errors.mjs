/**
 * Slack Web API error mapping, shared by the declarative operations and the hand-written ones.
 *
 * Slack answers HTTP 200 with `{"ok": false, "error": "<code>"}` for almost every failure
 * (https://docs.slack.dev/apis/web-api/#responses), and HTTP 429 with a Retry-After header when rate limited.
 */

export const SLACK_ERRORS = {
  okPath: "ok",
  okValue: true,
  // Validation failures add details in response_metadata.messages; otherwise the code is the only message.
  messagePath: ["response_metadata.messages.0", "error"],
  codePath: "error",
  kindByCode: {
    invalid_auth: "auth_error",
    not_authed: "auth_error",
    account_inactive: "auth_error",
    token_revoked: "auth_error",
    token_expired: "auth_error",
    not_allowed_token_type: "auth_error",
    missing_scope: "permission_denied",
    no_permission: "permission_denied",
    not_in_channel: "permission_denied",
    restricted_action: "permission_denied",
    ekm_access_denied: "permission_denied",
    cant_update_message: "permission_denied",
    channel_not_found: "not_found",
    message_not_found: "not_found",
    thread_not_found: "not_found",
    user_not_found: "not_found",
    users_not_found: "not_found",
    file_not_found: "not_found",
    no_reaction: "not_found",
    invalid_arguments: "invalid_input",
    invalid_arg_name: "invalid_input",
    invalid_cursor: "invalid_input",
    invalid_ts_latest: "invalid_input",
    invalid_ts_oldest: "invalid_input",
    invalid_blocks: "invalid_input",
    no_text: "invalid_input",
    msg_too_long: "invalid_input",
    too_many_attachments: "invalid_input",
    is_archived: "invalid_input",
    already_reacted: "invalid_input",
    invalid_name: "invalid_input",
    ratelimited: "rate_limited",
    rate_limited: "rate_limited",
  },
};
