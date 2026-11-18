/**
 * Seen-id operations: the polling building block. `filter_unseen` checks and marks in one locked
 * read-modify-write, so two overlapping runs never both get the same id as new.
 */
import { DAY_MS, normalizeId, normalizeIds, requireNamespace } from "../lib/limits.mjs";
import { formatTime, isExpired, markIdsSeen, partitionIds } from "../lib/namespace-state.mjs";
import { IDS_PARAMETER, NAMESPACE_PARAMETER, TTL_DAYS_PARAMETER } from "./common.mjs";

const filterUnseenOperation = {
  name: "filter_unseen",
  title: "Filter unseen ids",
  description:
    "Return the ids not seen before in this namespace (`new_ids`, in input order). With mark=true (default) every given id is marked seen in the same atomic step, so a later or overlapping run never gets them again. For at-least-once processing use mark=false, then mark_seen after the items were handled.",
  parameters: {
    type: "object",
    properties: {
      namespace: NAMESPACE_PARAMETER,
      ids: IDS_PARAMETER,
      mark: { type: "boolean", description: "Mark the given ids seen in the same step (default true)", default: true },
      ttl_days: TTL_DAYS_PARAMETER,
    },
    required: ["namespace", "ids"],
  },
  run: async ({ client, args, signal }) => {
    const namespace = requireNamespace(args.namespace);
    const ids = normalizeIds(args.ids);
    if (!args.mark) {
      const { newIds, seenIds } = partitionIds(await client.readNamespace(namespace), ids, client.now());
      return { data: { new_ids: newIds, new_count: newIds.length, seen_count: seenIds.length, marked: false, dropped_count: 0 } };
    }
    const data = await client.updateNamespace(
      namespace,
      (state, nowMs) => {
        const { newIds, seenIds } = partitionIds(state, ids, nowMs);
        const droppedCount = markIdsSeen(state, ids, { nowMs, ttlMs: args.ttl_days * DAY_MS });
        return { new_ids: newIds, new_count: newIds.length, seen_count: seenIds.length, marked: true, dropped_count: droppedCount };
      },
      { signal },
    );
    return { data };
  },
};

const markSeenOperation = {
  name: "mark_seen",
  title: "Mark ids seen",
  description: "Mark ids seen in this namespace. Ids already seen get a fresh expiry. When the namespace holds over 100000 ids the least recently seen are dropped (`dropped_count`).",
  parameters: {
    type: "object",
    properties: { namespace: NAMESPACE_PARAMETER, ids: IDS_PARAMETER, ttl_days: TTL_DAYS_PARAMETER },
    required: ["namespace", "ids"],
  },
  run: async ({ client, args, signal }) => {
    const namespace = requireNamespace(args.namespace);
    const ids = normalizeIds(args.ids);
    const data = await client.updateNamespace(
      namespace,
      (state, nowMs) => {
        const { newIds } = partitionIds(state, ids, nowMs);
        const droppedCount = markIdsSeen(state, ids, { nowMs, ttlMs: args.ttl_days * DAY_MS });
        return { marked_count: ids.length, new_count: newIds.length, dropped_count: droppedCount };
      },
      { signal },
    );
    return { data };
  },
};

const isSeenOperation = {
  name: "is_seen",
  title: "Is id seen",
  description: "Check whether one id is seen (and not expired) in this namespace, with when it was first seen and when it expires.",
  parameters: { type: "object", properties: { namespace: NAMESPACE_PARAMETER, item_id: { type: "string", description: "Item id (named item_id because `id` is the node id in workflows)" } }, required: ["namespace", "item_id"] },
  run: async ({ client, args }) => {
    const namespace = requireNamespace(args.namespace);
    const id = normalizeId(args.item_id, "item_id");
    const entry = (await client.readNamespace(namespace)).seen.get(id);
    const isSeen = Boolean(entry) && !isExpired(entry, client.now());
    return { data: { id, seen: isSeen, seen_at: isSeen ? formatTime(entry.seenAt) : null, expires_at: isSeen ? formatTime(entry.expiresAt) : null } };
  },
};

const forgetSeenOperation = {
  name: "forget_seen",
  title: "Forget seen ids",
  description: "Remove ids from the seen set, so filter_unseen reports them as new again.",
  parameters: { type: "object", properties: { namespace: NAMESPACE_PARAMETER, ids: IDS_PARAMETER }, required: ["namespace", "ids"] },
  run: async ({ client, args, signal }) => {
    const namespace = requireNamespace(args.namespace);
    const ids = normalizeIds(args.ids);
    const data = await client.updateNamespace(namespace, (state) => ({ forgotten_count: ids.filter((id) => state.seen.delete(id)).length }), { signal });
    return { data };
  },
};

export const seenOperations = [filterUnseenOperation, markSeenOperation, isSeenOperation, forgetSeenOperation];
