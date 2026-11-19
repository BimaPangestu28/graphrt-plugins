/**
 * Test doubles for pg and pg-cursor, and a runner wired to them. Nothing here opens a socket.
 *
 * A scenario decides what the fake server does:
 *   onQuery(text, values, client) → result `{command, rowCount, fields, rows}` or throws; default: empty result
 *   cursorFields / cursorRows   → what a cursor returns (rows are arrays); cursorError → read fails
 *   connectError                 → pool.connect() rejects with it
 *   holdCursor                   → cursor reads never answer (for cancel tests); cursorDelayMs → they answer late
 *   wireBytesPerRow              → bytes the socket receives per row (default: the row's JSON size)
 *   isSuperuser                  → what the is_superuser check answers
 */
import { EventEmitter } from "node:events";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const TEST_PASSWORD = "Sup3r:S3cret@pw";
export const TEST_URL = `postgres://app:${encodeURIComponent(TEST_PASSWORD)}@db.example.com:5432/shop`;

/**
 * Builds fake pg modules that record everything.
 *
 * @param scenario - See module docs (object)
 * @returns `{modules: {pg, Cursor}, log}`; log has `pools`, `clients`, `queries`, `cancelQueries` (object)
 */
export function createFakeDriverModules(scenario = {}) {
  const log = { pools: [], clients: [], queries: [], cancelQueries: [], cursors: [], readSizes: [], warnings: [] };

  class FakeCursor {
    constructor(text, values, config) {
      Object.assign(this, { text, values, config, closed: false, offset: 0 });
      log.cursors.push(this);
    }
    read(batchSize, callback) {
      log.readSizes.push(batchSize);
      if (scenario.holdCursor) return;
      if (scenario.cursorError) return setImmediate(() => callback(scenario.cursorError));
      const rows = (scenario.cursorRows ?? []).slice(this.offset, this.offset + batchSize);
      this.offset += rows.length;
      const fields = (scenario.cursorFields ?? []).map(([name, dataTypeID]) => ({ name, dataTypeID }));
      // Like the network: the rows' bytes arrive on the socket before the batch is handed over.
      const stream = this.client.connection.stream;
      for (const row of rows) {
        if (stream.destroyed) break;
        stream.emit("data", Buffer.alloc(scenario.wireBytesPerRow ?? Buffer.byteLength(JSON.stringify(row))));
      }
      const deliver = () => (stream.destroyed ? callback(new Error("Connection terminated unexpectedly")) : callback(null, rows, { fields }));
      if (scenario.cursorDelayMs) setTimeout(deliver, scenario.cursorDelayMs);
      else setImmediate(deliver);
    }
    async close() {
      this.closed = true;
    }
  }

  // Like pg's Client, an unexpected disconnect is emitted as 'error' (which crashes Node without a listener).
  class FakePoolClient extends EventEmitter {
    constructor(pool) {
      super();
      const stream = Object.assign(new EventEmitter(), {
        destroyed: false,
        destroy: () => {
          stream.destroyed = true;
          setImmediate(() => this.emit("error", new Error("Connection terminated unexpectedly")));
        },
      });
      Object.assign(this, { pool, processID: 42, released: null, connection: { stream } });
      log.clients.push(this);
    }
    // Like pg: a submittable (cursor) is returned as is, everything else gets a promise.
    query(statement, values) {
      if (statement instanceof FakeCursor) {
        log.queries.push({ text: `CURSOR ${statement.text}`, values: statement.values });
        statement.client = this;
        return statement;
      }
      return this.runQuery(statement, values);
    }
    async runQuery(statement, values) {
      const text = typeof statement === "string" ? statement : statement.text;
      const entry = { text, values: typeof statement === "string" ? values : statement.values, config: typeof statement === "string" ? null : statement };
      log.queries.push(entry);
      const result = await scenario.onQuery?.(text, entry.values, this);
      if (result) return result;
      if (text.includes("is_superuser")) return { command: "SELECT", rowCount: 1, fields: [], rows: [{ is_superuser: Boolean(scenario.isSuperuser) }] };
      return { command: text.split(" ")[0], rowCount: 0, fields: [], rows: [] };
    }
    release(destroy) {
      this.released = destroy ? "destroyed" : "returned";
    }
  }

  class FakePool {
    constructor(config) {
      Object.assign(this, { config, ended: false, errorListeners: [] });
      log.pools.push(this);
    }
    async connect() {
      if (scenario.connectError) throw scenario.connectError;
      return new FakePoolClient(this);
    }
    on(eventName, listener) {
      if (eventName === "error") this.errorListeners.push(listener);
    }
    async end() {
      this.ended = true;
    }
  }

  class FakeCancelClient {
    constructor(config) {
      this.config = config;
    }
    async connect() {}
    async query(text, values) {
      log.cancelQueries.push({ text, values });
      return { rows: [] };
    }
    async end() {}
  }

  const types = {
    getTypeParser: () => (text) => text,
    arrayParser: { create: (text, transform) => ({ parse: () => text.slice(1, -1).split(",").map(transform) }) },
  };
  return { modules: { pg: { Pool: FakePool, Client: FakeCancelClient, types }, Cursor: FakeCursor }, log };
}

/**
 * Runs `work` with a runner wired to fake driver modules.
 *
 * @param options - `{scenario, environment, definitionOptions}` (object)
 * @param work - `async ({runOperation, log, definition}) => void` (function)
 * @returns Promise of work's result
 */
export async function withRunner({ scenario = {}, environment = {}, definitionOptions = {} } = {}, work) {
  const { modules, log } = createFakeDriverModules(scenario);
  const definition = createPluginDefinition({ loadDriverModules: async () => modules, logWarning: (message) => log.warnings.push(message), ...definitionOptions });
  const runOperation = createOperationRunner(definition, { POSTGRES_URL: TEST_URL, ...environment });
  try {
    return await work({ runOperation, log, definition });
  } finally {
    await definition.closeAllConnections();
  }
}

/** Query texts in the order they were sent, without parameters. */
export function queryTexts(log) {
  return log.queries.map((entry) => entry.text.trim().split("\n")[0]);
}
