/**
 * Test double for mysql2 (core callback API) and a runner wired to it. Nothing here opens a socket.
 *
 * A scenario decides what the fake server does:
 *   onSimple(sql, values)  → result for session statements (SET, START TRANSACTION, ROLLBACK) or throws
 *   statement              → `{fields: [[name, columnType, characterSet?]], rows: [[...]], header, error, hold, wireBytesPerRow}` for the user statement
 *   connectError           → pool.getConnection fails with it
 */
import { EventEmitter } from "node:events";
import { createOperationRunner } from "../lib/shared/operations.mjs";
import { createPluginDefinition } from "../definition.mjs";

export const TEST_PASSWORD = "Sup3r:S3cret@pw";
export const TEST_URL = `mysql://app:${encodeURIComponent(TEST_PASSWORD)}@db.example.com:3306/shop`;

/**
 * Builds a fake mysql2 module that records everything.
 *
 * @param scenario - See module docs (object)
 * @returns `{mysql, log}`; log has `pools`, `connections`, `statements`, `killQueries` (object)
 */
export function createFakeMysql(scenario = {}) {
  const log = { pools: [], connections: [], statements: [], killQueries: [] };

  const emitStatement = (command, connection) => {
    const statement = scenario.statement ?? {};
    if (statement.hold) return;
    setImmediate(() => {
      if (statement.error) return command.emit("error", statement.error);
      if (statement.fields) {
        command.emit("fields", statement.fields.map(([name, columnType, characterSet = 255]) => ({ name, columnType, characterSet })));
        for (const row of statement.rows ?? []) {
          // Like the network: the row's bytes arrive on the socket before mysql2 emits the row.
          connection.stream.emit("data", Buffer.alloc(statement.wireBytesPerRow ?? Buffer.byteLength(JSON.stringify(row))));
          if (connection.destroyed) return;
          command.emit("result", row);
        }
      }
      if (statement.header) command.emit("result", statement.header);
      command.emit("end");
    });
  };

  class FakeConnection {
    constructor() {
      Object.assign(this, { threadId: 7, state: "open", destroyed: false, stream: new EventEmitter() });
      log.connections.push(this);
    }
    query(sqlOrOptions, values, callback) {
      if (typeof sqlOrOptions === "object") return this.startStatement("query", sqlOrOptions, []);
      log.statements.push({ protocol: "simple", sql: sqlOrOptions, values });
      Promise.resolve()
        .then(() => scenario.onSimple?.(sqlOrOptions, values))
        .then((result) => callback(null, result ?? {}), (simpleError) => callback(simpleError));
      return undefined;
    }
    execute(options, values) {
      return this.startStatement("execute", options, values);
    }
    startStatement(protocol, options, values) {
      log.statements.push({ protocol, sql: options.sql, values, rowsAsArray: options.rowsAsArray });
      const command = new EventEmitter();
      emitStatement(command, this);
      return command;
    }
    pause() {}
    release() {
      this.state = "released";
    }
    destroy() {
      this.state = "destroyed";
      this.destroyed = true;
    }
  }

  class FakePool extends EventEmitter {
    constructor(options) {
      super();
      Object.assign(this, { options, ended: false });
      log.pools.push(this);
    }
    getConnection(callback) {
      setImmediate(() => (scenario.connectError ? callback(scenario.connectError) : callback(null, new FakeConnection())));
    }
    end(callback) {
      this.ended = true;
      callback?.();
    }
  }

  const mysql = {
    createPool: (options) => new FakePool(options),
    createConnection: (options) => ({
      options,
      on() {},
      query(sql, values, callback) {
        log.killQueries.push({ sql, values });
        setImmediate(() => callback(null));
      },
      destroy() {},
    }),
  };
  return { mysql, log };
}

/**
 * Runs `work` with a runner wired to the fake mysql2.
 *
 * @param options - `{scenario, environment, definitionOptions}` (object)
 * @param work - `async ({runOperation, log, definition}) => void` (function)
 * @returns Promise of work's result
 */
export async function withRunner({ scenario = {}, environment = {}, definitionOptions = {} } = {}, work) {
  const { mysql, log } = createFakeMysql(scenario);
  const definition = createPluginDefinition({ loadMysql: async () => mysql, logWarning: () => {}, ...definitionOptions });
  const runOperation = createOperationRunner(definition, { MYSQL_URL: TEST_URL, ...environment });
  try {
    return await work({ runOperation, log, definition });
  } finally {
    await definition.closeAllConnections();
  }
}

/** Statement texts in the order they were sent. */
export function statementTexts(log) {
  return log.statements.map((entry) => entry.sql.trim().split("\n")[0]);
}
