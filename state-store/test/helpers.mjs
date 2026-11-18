import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createStateStoreDefinition } from "../definition.mjs";

export const START_TIME_MS = Date.parse("2026-11-18T10:00:00.000Z");

/**
 * Creates a temp store directory and a controllable clock.
 *
 * @returns `{storeDirectory, environment, clock: {now, advanceBy}, cleanup}` (Promise<object>)
 */
export async function createTestStore() {
  const storeDirectory = await mkdtemp(join(tmpdir(), "state-store-test-"));
  let currentTimeMs = START_TIME_MS;
  const clock = { now: () => currentTimeMs, advanceBy: (deltaMs) => (currentTimeMs += deltaMs) };
  return { storeDirectory, environment: { STATE_STORE_DIR: storeDirectory }, clock, cleanup: () => rm(storeDirectory, { recursive: true, force: true }) };
}

/**
 * Creates an operation runner (like one plugin process) on a test store.
 *
 * @param testStore - From createTestStore (object)
 * @param overrides - Extra definition dependencies, e.g. `{lockerOptions: {pid}}` (object)
 * @returns `(operationName, args, {source}) => Promise<{data, next_cursor}>` (function)
 */
export function createTestRunner(testStore, overrides = {}) {
  const definition = createStateStoreDefinition({ now: testStore.clock.now, logWarning: () => {}, ...overrides });
  const runOperation = createOperationRunner(definition, testStore.environment);
  return (operationName, args, options = {}) => runOperation(operationName, args, { source: options.source ?? "tool", signal: options.signal });
}
