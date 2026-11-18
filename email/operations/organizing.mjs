/**
 * Mailbox changes over IMAP: mark messages seen/unseen and move them.
 * These are writes: a failure after the command was sent is not retryable.
 *
 * imapflow does not throw when the server refuses a STORE or MOVE; it
 * returns `false`. That is reported as an `api_error` with an unknown
 * outcome, never as success. UIDs that do not exist are skipped and listed
 * in `missing_uids`; when none exist nothing is sent and the call is
 * `not_found`.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { invalidInput, notFound } from "../lib/errors.mjs";
import { assertWriteReported, withMailbox, writeOutcomeUnknown } from "../lib/imap.mjs";
import { MAILBOX_PROPERTY, UIDS_PROPERTY, parseUidList, validateMailboxPath } from "./common.mjs";

const SEEN_FLAG = "\\Seen";
// Without one of these, imapflow emulates MOVE with COPY + \Deleted + a plain EXPUNGE, which also
// removes every other message already flagged \Deleted in the mailbox.
const SAFE_MOVE_CAPABILITIES = ["MOVE", "UIDPLUS"];

export const organizingOperations = [
  createSeenFlagOperation({ name: "mark_seen", title: "Mark email seen", addFlag: true }),
  createSeenFlagOperation({ name: "mark_unseen", title: "Mark email unseen", addFlag: false }),
  {
    name: "move_message",
    title: "Move email",
    description:
      "Move messages by UID to another mailbox (e.g. an archive folder or \"[Gmail]/Trash\"). Returns the new UIDs when the server reports them. " +
      "Needs a server with the MOVE or UIDPLUS extension.",
    parameters: {
      type: "object",
      properties: {
        uids: UIDS_PROPERTY,
        mailbox: MAILBOX_PROPERTY,
        destination: { type: "string", description: "Target mailbox path as shown by list_mailboxes" },
      },
      required: ["uids", "destination"],
    },
    run: async ({ client, args, signal }) => {
      const uids = parseUidList(args.uids);
      const mailboxPath = validateMailboxPath("mailbox", args.mailbox);
      const destination = validateMailboxPath("destination", args.destination);
      if (destination === mailboxPath) throw invalidInput("`destination` must differ from `mailbox`");
      return client.withImap(
        (imapClient) => {
          assertSafeMoveSupported(imapClient);
          return withMailbox(imapClient, mailboxPath, { readOnly: false }, () => moveExistingMessages(imapClient, { uids, mailboxPath, destination }));
        },
        { signal, isWrite: true },
      );
    },
  },
];

function createSeenFlagOperation({ name, title, addFlag }) {
  return {
    name,
    title,
    description: `${addFlag ? "Set" : "Clear"} the \\Seen flag on messages by UID (${addFlag ? "mark as read" : "mark as unread"}). UIDs that do not exist are listed in missing_uids.`,
    parameters: {
      type: "object",
      properties: { uids: UIDS_PROPERTY, mailbox: MAILBOX_PROPERTY },
      required: ["uids"],
    },
    run: async ({ client, args, signal }) => {
      const uids = parseUidList(args.uids);
      const mailboxPath = validateMailboxPath("mailbox", args.mailbox);
      return client.withImap(
        (imapClient) => withMailbox(imapClient, mailboxPath, { readOnly: false }, () => changeSeenFlag(imapClient, { uids, mailboxPath, addFlag })),
        { signal, isWrite: true },
      );
    },
  };
}

async function changeSeenFlag(imapClient, { uids, mailboxPath, addFlag }) {
  const { existingUids, missingUids } = await splitExistingUids(imapClient, uids, mailboxPath);
  if (existingUids.length === 0) throw notFound(`None of the UIDs ${uids.join(",")} exist in ${JSON.stringify(mailboxPath)}; nothing was changed`);
  const changeFlags = addFlag ? imapClient.messageFlagsAdd.bind(imapClient) : imapClient.messageFlagsRemove.bind(imapClient);
  const changeResult = await changeFlags(existingUids.join(","), [SEEN_FLAG], { uid: true });
  assertWriteReported(changeResult, `The IMAP server did not confirm the \\Seen change on ${existingUids.join(",")} in ${JSON.stringify(mailboxPath)}`);
  return { data: { updated: true, mailbox: mailboxPath, uids: existingUids, missing_uids: missingUids, seen: addFlag } };
}

async function moveExistingMessages(imapClient, { uids, mailboxPath, destination }) {
  const { existingUids, missingUids } = await splitExistingUids(imapClient, uids, mailboxPath);
  if (existingUids.length === 0) throw notFound(`None of the UIDs ${uids.join(",")} exist in ${JSON.stringify(mailboxPath)}; nothing was moved`);
  const moveResult = await imapClient.messageMove(existingUids.join(","), destination, { uid: true });
  if (!moveResult) {
    throw writeOutcomeUnknown(
      `The IMAP server did not confirm moving ${existingUids.join(",")} to ${JSON.stringify(destination)}: the messages may or may not have been moved. ` +
        "Check both mailboxes (and that the destination exists, see list_mailboxes) before trying again.",
    );
  }
  return { data: shapeMoveResult({ uids: existingUids, missingUids, mailboxPath, destination, moveResult }) };
}

/**
 * Splits UIDs into those that exist in the selected mailbox and those that do not (UID SEARCH).
 *
 * @param imapClient - Connected ImapFlow with the mailbox selected (object)
 * @param uids - Requested UIDs (number[])
 * @param mailboxPath - For error messages (string)
 * @returns `{existingUids, missingUids}` in the requested order (Promise<object>)
 * @throws PluginError kind `api_error` - When the server refuses the search
 */
async function splitExistingUids(imapClient, uids, mailboxPath) {
  const foundUids = await imapClient.search({ uid: uids.join(",") }, { uid: true });
  if (!Array.isArray(foundUids)) throw new PluginError(`The IMAP server refused to look up UIDs ${uids.join(",")} in ${JSON.stringify(mailboxPath)}; nothing was changed`, { kind: "api_error" });
  const foundUidSet = new Set(foundUids.map(Number));
  return { existingUids: uids.filter((uid) => foundUidSet.has(uid)), missingUids: uids.filter((uid) => !foundUidSet.has(uid)) };
}

function assertSafeMoveSupported(imapClient) {
  if (SAFE_MOVE_CAPABILITIES.some((capability) => imapClient.capabilities?.has?.(capability))) return;
  throw invalidInput(
    "This IMAP server supports neither MOVE nor UIDPLUS, so a move would end with a plain EXPUNGE that also deletes every other message " +
      "marked \\Deleted in the mailbox. move_message refuses to do that; nothing was changed.",
  );
}

function shapeMoveResult({ uids, missingUids, mailboxPath, destination, moveResult }) {
  const uidMap = moveResult.uidMap instanceof Map ? Object.fromEntries([...moveResult.uidMap].map(([sourceUid, targetUid]) => [String(sourceUid), targetUid])) : null;
  return {
    moved: true,
    mailbox: mailboxPath,
    destination: moveResult.destination ?? destination,
    uids,
    missing_uids: missingUids,
    new_uids: uidMap,
    moved_count: uidMap ? Object.keys(uidMap).length : null,
  };
}
