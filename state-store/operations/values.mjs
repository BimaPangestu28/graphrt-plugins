/**
 * Key/value operations. Values are any JSON (at most 1 MB each) with an optional TTL.
 * `increment` is an atomic counter: the read and the write happen under the namespace lock.
 */
import { PluginError } from "../lib/shared/graphrt-plugin.mjs";
import { requireKey, requireNamespace, requireStorableValue } from "../lib/limits.mjs";
import { formatTime, isExpired } from "../lib/namespace-state.mjs";
import { CURSOR_PARAMETER, KEY_PARAMETER, LIMIT_PARAMETER, NAMESPACE_PARAMETER, TTL_SECONDS_PARAMETER, paginateByName } from "./common.mjs";

function describeEntry(key, entry) {
  return { key, updated_at: formatTime(entry.updatedAt), expires_at: formatTime(entry.expiresAt) };
}

function computeExpiry(nowMs, ttlSeconds) {
  return ttlSeconds === undefined ? null : nowMs + ttlSeconds * 1000;
}

const getOperation = {
  name: "get",
  title: "Get value",
  description: "Read a key's JSON value. Returns found=false (value null) when the key is missing or expired.",
  parameters: { type: "object", properties: { namespace: NAMESPACE_PARAMETER, key: KEY_PARAMETER }, required: ["namespace", "key"] },
  run: async ({ client, args }) => {
    const key = requireKey(args.key);
    const entry = (await client.readNamespace(requireNamespace(args.namespace))).values.get(key);
    if (!entry || isExpired(entry, client.now())) return { data: { key, found: false, value: null, updated_at: null, expires_at: null } };
    return { data: { ...describeEntry(key, entry), found: true, value: entry.value } };
  },
};

const setOperation = {
  name: "set",
  title: "Set value",
  description: "Store a JSON value (object, array, string, number, boolean or null; at most 1 MB) under a key, replacing any old value. Optional ttl_seconds.",
  parameters: {
    type: "object",
    properties: {
      namespace: NAMESPACE_PARAMETER,
      key: KEY_PARAMETER,
      value: { description: "Any JSON value" },
      ttl_seconds: TTL_SECONDS_PARAMETER,
    },
    required: ["namespace", "key", "value"],
  },
  run: async ({ client, args, signal }) => {
    const namespace = requireNamespace(args.namespace);
    const key = requireKey(args.key);
    const value = requireStorableValue(args.value);
    const data = await client.updateNamespace(
      namespace,
      (state, nowMs) => {
        const entry = { value, updatedAt: nowMs, expiresAt: computeExpiry(nowMs, args.ttl_seconds) };
        state.values.set(key, entry);
        return describeEntry(key, entry);
      },
      { signal },
    );
    return { data };
  },
};

const deleteOperation = {
  name: "delete",
  title: "Delete key",
  description: "Delete a key. Returns deleted=false when it did not exist (or had expired).",
  parameters: { type: "object", properties: { namespace: NAMESPACE_PARAMETER, key: KEY_PARAMETER }, required: ["namespace", "key"] },
  run: async ({ client, args, signal }) => {
    const namespace = requireNamespace(args.namespace);
    const key = requireKey(args.key);
    const data = await client.updateNamespace(namespace, (state) => ({ key, deleted: state.values.delete(key) }), { signal });
    return { data };
  },
};

const listKeysOperation = {
  name: "list_keys",
  title: "List keys",
  description: "List keys (sorted, optionally only those starting with `prefix`) with their update and expiry times. Values are not included; use get.",
  parameters: {
    type: "object",
    properties: {
      namespace: NAMESPACE_PARAMETER,
      prefix: { type: "string", description: "Only keys starting with this" },
      limit: LIMIT_PARAMETER,
      cursor: CURSOR_PARAMETER,
    },
    required: ["namespace"],
  },
  run: async ({ client, args }) => {
    const state = await client.readNamespace(requireNamespace(args.namespace));
    const nowMs = client.now();
    const matchingKeys = [...state.values]
      .filter(([key, entry]) => key.startsWith(args.prefix ?? "") && !isExpired(entry, nowMs))
      .map(([key, entry]) => describeEntry(key, entry))
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const { pageItems, nextCursor } = paginateByName(matchingKeys, (item) => item.key, args);
    return { data: { keys: pageItems }, next_cursor: nextCursor };
  },
};

const incrementOperation = {
  name: "increment",
  title: "Increment counter",
  description:
    "Atomically add `by` (default 1, may be negative) to an integer value and return the new value. A missing or expired key starts at 0; ttl_seconds applies only when the counter is created, so a counter with a TTL counts within a fixed window.",
  parameters: {
    type: "object",
    properties: {
      namespace: NAMESPACE_PARAMETER,
      key: KEY_PARAMETER,
      by: { type: "integer", description: "Amount to add (default 1)", default: 1 },
      ttl_seconds: TTL_SECONDS_PARAMETER,
    },
    required: ["namespace", "key"],
  },
  run: async ({ client, args, signal }) => {
    const namespace = requireNamespace(args.namespace);
    const key = requireKey(args.key);
    const data = await client.updateNamespace(namespace, (state, nowMs) => applyIncrement(state, { key, by: args.by, ttlSeconds: args.ttl_seconds, nowMs }), { signal });
    return { data };
  },
};

function applyIncrement(state, { key, by, ttlSeconds, nowMs }) {
  const existing = state.values.get(key);
  if (existing && !Number.isSafeInteger(existing.value)) {
    throw new PluginError(`Key ${JSON.stringify(key)} holds ${JSON.stringify(existing.value)?.slice(0, 50)}, not an integer; nothing was changed`, { kind: "invalid_input" });
  }
  const newValue = (existing?.value ?? 0) + by;
  if (!Number.isSafeInteger(newValue)) throw new PluginError(`Counter ${JSON.stringify(key)} would leave the safe integer range`, { kind: "invalid_input" });
  const entry = { value: newValue, updatedAt: nowMs, expiresAt: existing ? existing.expiresAt : computeExpiry(nowMs, ttlSeconds) };
  state.values.set(key, entry);
  return { ...describeEntry(key, entry), value: newValue };
}

export const valueOperations = [getOperation, setOperation, deleteOperation, listKeysOperation, incrementOperation];
