/**
 * state-store plugin definition: a local, file-backed store so polling workflows never handle the same
 * item twice (seen ids with TTL), plus small JSON key/values and atomic counters.
 *
 * There is no token and no network: `localOnly` makes the manifest ask for neither, and
 * `resolveAccessToken` returns "local". STATE_STORE_DIR is `tokenEnv` only so that it is listed in the
 * manifest's env permissions.
 *
 * The locker and the per-namespace queue live here, not in the client: the runner builds a new client
 * for every call, and the queue must be shared by all calls of this process.
 */
import { createStateStoreClient, STATE_STORE_DIR_ENV } from "./lib/client.mjs";
import { createNamespaceLocker } from "./lib/namespace-lock.mjs";
import { namespaceOperations } from "./operations/namespaces.mjs";
import { seenOperations } from "./operations/seen.mjs";
import { valueOperations } from "./operations/values.mjs";

/**
 * Builds the plugin definition with injectable side effects.
 *
 * @param dependencyOverrides - `{now, lockerOptions, fileSystem, homeDirectory, logWarning}` (object, all optional)
 * @param dependencyOverrides.lockerOptions - Options for createNamespaceLocker, e.g. `{pid, isProcessAlive, lockTimeoutMs}` (object)
 * @returns Plugin definition for the shared runner (object)
 *
 * @example
 * const definition = createStateStoreDefinition({ now: () => Date.parse("2026-11-18T00:00:00Z") });
 */
export function createStateStoreDefinition(dependencyOverrides = {}) {
  const { lockerOptions, ...otherOverrides } = dependencyOverrides;
  const dependencies = {
    now: Date.now,
    ...otherOverrides,
    // The locker keeps real time for its waits; `now` only drives TTLs and timestamps.
    locker: createNamespaceLocker({ fileSystem: otherOverrides.fileSystem, logWarning: otherOverrides.logWarning, ...lockerOptions }),
    namespaceQueue: createKeyedSerialQueue(),
  };
  return {
    name: "state-store",
    version: "0.1.0",
    description: "Local state for workflows: seen-id sets with TTL for polling (filter_unseen), JSON key/values and atomic counters, in JSON files",
    tokenEnv: STATE_STORE_DIR_ENV,
    localOnly: true,
    limits: { timeout_ms: 60000, max_concurrency: 8 },
    resolveAccessToken: () => "local",
    createClient: ({ environment }) => createStateStoreClient(environment, dependencies),
    operations: [...seenOperations, ...valueOperations, ...namespaceOperations],
  };
}

// Runs tasks with the same key one after another; different keys run in parallel.
function createKeyedSerialQueue() {
  const tailsByKey = new Map();
  return (key, task) => {
    const previousTail = tailsByKey.get(key) ?? Promise.resolve();
    const result = previousTail.then(task);
    const newTail = result.catch(() => {});
    tailsByKey.set(key, newTail);
    newTail.then(() => {
      if (tailsByKey.get(key) === newTail) tailsByKey.delete(key);
    });
    return result;
  };
}

export const pluginDefinition = createStateStoreDefinition();
