# email operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `email.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `verify_connection` | Check that the SMTP and/or IMAP settings and password work: connects, logs in and disconnects. Sends nothing and changes nothing. | protocol |
| `send_email` | Send an email over SMTP from EMAIL_FROM. At most 50 recipients per message; every recipient counts toward the daily cap (EMAIL_DAILY_SEND_LIMIT). Never retried automatically. As an agent tool: only recipients in EMAIL_TOOL_ALLOWED_RECIPIENTS (refused when unset) and no attachments. | **to**, cc, bcc, **subject**, text, html, reply_to, in_reply_to, references, attachments |
| `list_messages` | List messages in a mailbox, newest first, with sender, subject, date, flags and a short text snippet. Filters: unseen only, since a date, sender, subject text. | mailbox, unseen_only, since, from, subject, limit, cursor |
| `read_message` | Read one message by UID: headers, Message-ID and References for replying, the body as plain text (HTML converted to text, never rendered) and attachment metadata (attachments are not downloaded). | **uid**, mailbox, max_text_chars, mark_seen |
| `list_mailboxes` | List the account's mailboxes (folders) with their special use (\Sent, \Trash, \Junk, ...), optionally with message and unseen counts. | include_counts |
| `mark_seen` | Set the \Seen flag on messages by UID (mark as read). UIDs that do not exist are listed in missing_uids. | **uids**, mailbox |
| `mark_unseen` | Clear the \Seen flag on messages by UID (mark as unread). UIDs that do not exist are listed in missing_uids. | **uids**, mailbox |
| `move_message` | Move messages by UID to another mailbox (e.g. an archive folder or "[Gmail]/Trash"). Returns the new UIDs when the server reports them. Needs a server with the MOVE or UIDPLUS extension. | **uids**, mailbox, **destination** |
