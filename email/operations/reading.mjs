/**
 * Mailbox reading over IMAP: list and read messages, list mailboxes.
 *
 * Reads open the mailbox read-only (EXAMINE), so nothing changes on the
 * server unless `read_message` is asked to mark the message seen. HTML bodies
 * are converted to text and never rendered; attachment content is never
 * downloaded, only described.
 */
import { invalidInput, notFound } from "../lib/errors.mjs";
import { collapseWhitespace, convertHtmlToText } from "../lib/html-to-text.mjs";
import { assertWriteReported, withMailbox } from "../lib/imap.mjs";
import { cleanBodyText, cleanHeaderText, findBodyParts, formatAddressList, formatDate, parseReferencesHeader, readStreamText } from "../lib/message-parts.mjs";
import { MAILBOX_PROPERTY, parseSinceDate, validateMailboxPath, validateSearchText } from "./common.mjs";

export const SNIPPET_CHARS = 200;
const SNIPPET_SOURCE_BYTES = 4096;
/** Bytes of one body part read for read_message; text beyond it is reported as truncated. */
export const MAX_BODY_PART_BYTES = 1024 * 1024;
const SUMMARY_FETCH_QUERY = { uid: true, envelope: true, flags: true, internalDate: true, size: true, bodyStructure: true };

export const readingOperations = [
  {
    name: "list_messages",
    title: "List email messages",
    description: "List messages in a mailbox, newest first, with sender, subject, date, flags and a short text snippet. Filters: unseen only, since a date, sender, subject text.",
    parameters: {
      type: "object",
      properties: {
        mailbox: MAILBOX_PROPERTY,
        unseen_only: { type: "boolean", default: false, description: "Only messages without the \\Seen flag" },
        since: { type: "string", description: "Only messages received on or after this date (YYYY-MM-DD; IMAP compares whole days)" },
        from: { type: "string", description: "Only messages whose From contains this text" },
        subject: { type: "string", description: "Only messages whose subject contains this text" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Messages per page" },
        cursor: { type: "string", description: "next_cursor from the previous page" },
      },
    },
    run: async ({ client, args, signal }) => {
      const mailboxPath = validateMailboxPath("mailbox", args.mailbox);
      const searchQuery = buildSearchQuery(args);
      return client.withImap(
        (imapClient) => withMailbox(imapClient, mailboxPath, { readOnly: true }, (mailbox) => listMessagePage(imapClient, mailbox, { mailboxPath, searchQuery, args })),
        { signal },
      );
    },
  },
  {
    name: "read_message",
    title: "Read email message",
    description:
      "Read one message by UID: headers, Message-ID and References for replying, the body as plain text (HTML converted to text, never rendered) and attachment metadata (attachments are not downloaded).",
    parameters: {
      type: "object",
      properties: {
        uid: { type: "integer", minimum: 1, maximum: 4294967295, description: "Message UID from list_messages" },
        mailbox: MAILBOX_PROPERTY,
        max_text_chars: { type: "integer", minimum: 100, maximum: 200000, default: 20000, description: "Longest body text returned" },
        mark_seen: { type: "boolean", default: false, description: "Also set the \\Seen flag (otherwise the message stays as it is)" },
      },
      required: ["uid"],
    },
    run: async ({ client, args, signal }) => {
      const mailboxPath = validateMailboxPath("mailbox", args.mailbox);
      return client.withImap(
        (imapClient) => withMailbox(imapClient, mailboxPath, { readOnly: !args.mark_seen }, () => readOneMessage(imapClient, { mailboxPath, args })),
        { signal, isWrite: args.mark_seen },
      );
    },
  },
  {
    name: "list_mailboxes",
    title: "List mailboxes",
    description: "List the account's mailboxes (folders) with their special use (\\Sent, \\Trash, \\Junk, ...), optionally with message and unseen counts.",
    parameters: {
      type: "object",
      properties: {
        include_counts: { type: "boolean", default: false, description: "Also return message and unseen counts (one STATUS per mailbox)" },
      },
    },
    run: async ({ client, args, signal }) =>
      client.withImap(async (imapClient) => {
        const listOptions = args.include_counts ? { statusQuery: { messages: true, unseen: true } } : {};
        const mailboxes = await imapClient.list(listOptions);
        return { data: { mailboxes: mailboxes.map(shapeMailbox) } };
      }, { signal }),
  },
];

/**
 * Builds the imapflow search query for list_messages.
 *
 * @param args - Validated arguments (object)
 * @returns imapflow SearchObject (object)
 * @throws PluginError kind `invalid_input` - On a bad date or text
 */
export function buildSearchQuery(args) {
  const searchQuery = {};
  if (args.unseen_only) searchQuery.seen = false;
  const sinceDate = parseSinceDate(args.since);
  if (sinceDate) searchQuery.since = sinceDate;
  const fromText = validateSearchText("from", args.from);
  if (fromText) searchQuery.from = fromText;
  const subjectText = validateSearchText("subject", args.subject);
  if (subjectText) searchQuery.subject = subjectText;
  return Object.keys(searchQuery).length > 0 ? searchQuery : { all: true };
}

async function listMessagePage(imapClient, mailbox, { mailboxPath, searchQuery, args }) {
  const uidValidity = String(mailbox.uidValidity);
  const beforeUid = parseCursor(args.cursor, uidValidity);
  const matchingUids = await imapClient.search(searchQuery, { uid: true });
  if (!Array.isArray(matchingUids)) throw invalidInput("The IMAP server refused the search (try simpler filters)");
  const newestFirst = matchingUids.filter((uid) => beforeUid === null || uid < beforeUid).sort((left, right) => right - left);
  const pageUids = newestFirst.slice(0, args.limit);
  const hasMore = newestFirst.length > pageUids.length;
  const fetchedMessages = pageUids.length ? await imapClient.fetchAll(pageUids.join(","), SUMMARY_FETCH_QUERY, { uid: true }) : [];
  fetchedMessages.sort((left, right) => right.uid - left.uid);
  const messages = [];
  // One FETCH at a time: imapflow cannot run commands while another is still streaming.
  for (const fetchedMessage of fetchedMessages) {
    messages.push({ ...shapeMessageSummary(fetchedMessage), snippet: await readSnippet(imapClient, fetchedMessage) });
  }
  return {
    data: { mailbox: mailboxPath, total_matching: matchingUids.length, messages },
    next_cursor: hasMore ? `${uidValidity}:${pageUids.at(-1)}` : null,
  };
}

function parseCursor(cursor, uidValidity) {
  if (!cursor) return null;
  const match = /^(\d+):(\d+)$/.exec(String(cursor).trim());
  if (!match) throw invalidInput("`cursor` is not a next_cursor from list_messages");
  if (match[1] !== uidValidity) throw invalidInput("The mailbox was rebuilt since this cursor was made (UIDVALIDITY changed): list again without `cursor`");
  return Number(match[2]);
}

function shapeMessageSummary(fetchedMessage) {
  const envelope = fetchedMessage.envelope ?? {};
  return {
    uid: fetchedMessage.uid,
    message_id: envelope.messageId ? cleanHeaderText(envelope.messageId) : null,
    from: formatAddressList(envelope.from),
    to: formatAddressList(envelope.to),
    cc: formatAddressList(envelope.cc),
    subject: cleanHeaderText(envelope.subject ?? ""),
    date: formatDate(envelope.date) ?? formatDate(fetchedMessage.internalDate),
    flags: [...(fetchedMessage.flags ?? [])],
    size_bytes: fetchedMessage.size ?? null,
    has_attachments: findBodyParts(fetchedMessage.bodyStructure).attachments.some((attachment) => attachment.disposition !== "inline"),
  };
}

async function readSnippet(imapClient, fetchedMessage) {
  const { textPart, htmlPart } = findBodyParts(fetchedMessage.bodyStructure);
  const previewPart = textPart ?? htmlPart;
  if (!previewPart) return "";
  const { text } = await downloadPartText(imapClient, fetchedMessage.uid, previewPart.part, SNIPPET_SOURCE_BYTES);
  const plainText = previewPart === htmlPart ? convertHtmlToText(text) : collapseWhitespace(cleanBodyText(text));
  return plainText.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

async function downloadPartText(imapClient, uid, partId, maxBytes) {
  const download = await imapClient.download(String(uid), partId, { uid: true, maxBytes });
  if (!download?.content) return { text: "", truncated: false };
  return readStreamText(download.content, maxBytes);
}

async function readOneMessage(imapClient, { mailboxPath, args }) {
  const fetchedMessage = await imapClient.fetchOne(String(args.uid), { ...SUMMARY_FETCH_QUERY, headers: ["references"] }, { uid: true });
  if (!fetchedMessage) throw notFound(`No message with UID ${args.uid} in ${JSON.stringify(mailboxPath)}`);
  const { textPart, htmlPart, attachments } = findBodyParts(fetchedMessage.bodyStructure);
  const body = await readBodyText(imapClient, args.uid, { textPart, htmlPart });
  if (args.mark_seen) {
    const flagResult = await imapClient.messageFlagsAdd(String(args.uid), ["\\Seen"], { uid: true });
    assertWriteReported(flagResult, `The IMAP server did not confirm setting \\Seen on UID ${args.uid} in ${JSON.stringify(mailboxPath)}`);
  }
  const summary = shapeMessageSummary(fetchedMessage);
  const envelope = fetchedMessage.envelope ?? {};
  return {
    data: {
      ...summary,
      mailbox: mailboxPath,
      flags: args.mark_seen ? [...new Set([...summary.flags, "\\Seen"])] : summary.flags,
      in_reply_to: envelope.inReplyTo ? cleanHeaderText(envelope.inReplyTo) : null,
      references: parseReferencesHeader(fetchedMessage.headers),
      reply_to: formatAddressList(envelope.replyTo),
      text: body.text.slice(0, args.max_text_chars),
      text_format: body.format,
      truncated: body.truncated || body.text.length > args.max_text_chars,
      attachments,
    },
  };
}

async function readBodyText(imapClient, uid, { textPart, htmlPart }) {
  if (textPart) {
    const { text, truncated } = await downloadPartText(imapClient, uid, textPart.part, MAX_BODY_PART_BYTES);
    return { text: cleanBodyText(text).trim(), format: "plain", truncated };
  }
  if (htmlPart) {
    const { text, truncated } = await downloadPartText(imapClient, uid, htmlPart.part, MAX_BODY_PART_BYTES);
    return { text: convertHtmlToText(cleanBodyText(text)), format: "html_converted", truncated };
  }
  return { text: "", format: "none", truncated: false };
}

function shapeMailbox(listEntry) {
  return {
    path: listEntry.path,
    name: listEntry.name,
    delimiter: listEntry.delimiter ?? null,
    special_use: listEntry.specialUse ?? null,
    flags: [...(listEntry.flags ?? [])],
    subscribed: Boolean(listEntry.subscribed),
    ...(listEntry.status ? { messages: listEntry.status.messages ?? null, unseen: listEntry.status.unseen ?? null } : {}),
  };
}
