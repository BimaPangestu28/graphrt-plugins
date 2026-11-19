/**
 * mysql plugin definition: parameterised SQL on MySQL and MariaDB with the mysql2 driver.
 *
 * The runner's "token" is the connection: a node's `access_token` (a
 * `mysql://` URL from a secret), else MYSQL_URL, else the MYSQL_* parts.
 * `resolveAccessToken` turns it into a connection object that carries its own
 * secrets, and every operation's errors pass through a redactor built from
 * them before they leave the plugin.
 *
 * The driver (and its pools) is created here, once per process: the runner
 * builds a new client for every call.
 */
import { createMysqlClient } from "./lib/client.mjs";
import { createRedactor, redactError } from "./lib/errors.mjs";
import { createMysqlDriver } from "./lib/mysql-driver.mjs";
import { CONNECTION_PART_VARIABLES, LIMIT_VARIABLES, resolveConnection, TOOL_WRITES_VARIABLE, URL_VARIABLE } from "./lib/settings.mjs";
import { schemaOperations } from "./operations/schema.mjs";
import { statementOperations } from "./operations/statements.mjs";

/**
 * Builds the plugin definition, optionally with injected side effects (tests).
 *
 * @param dependencies - createMysqlDriver dependencies, e.g. `{loadMysql, poolRegistryOptions}` (object, optional)
 * @returns Plugin definition with an extra `closeAllConnections()` for shutdown (object)
 */
export function createPluginDefinition(dependencies = {}) {
  const driver = createMysqlDriver(dependencies);
  const operations = [...statementOperations, ...schemaOperations];
  return {
    name: "mysql",
    version: "0.1.0",
    description: "MySQL and MariaDB: parameterised queries in read-only transactions, writes and DDL (nodes, or agents with an opt-in), tables, columns and query plans",
    tokenEnv: URL_VARIABLE,
    extraEnv: [...CONNECTION_PART_VARIABLES, ...LIMIT_VARIABLES, TOOL_WRITES_VARIABLE],
    limits: { timeout_ms: 120000, max_concurrency: 8 },
    resolveAccessToken: resolveConnectionRedacted,
    createClient: (runnerInputs) => createMysqlClient(runnerInputs, driver),
    operations: operations.map(withRedactedErrors),
    closeAllConnections: () => driver.closeAll(),
  };
}

// A malformed URL must not be echoed back, so even resolution errors are redacted with what was given.
function resolveConnectionRedacted(inputs) {
  try {
    return resolveConnection(inputs);
  } catch (resolveError) {
    throw redactError(resolveError, createRedactor([inputs.nodeToken, inputs.environment?.[URL_VARIABLE], inputs.environment?.MYSQL_PASSWORD]));
  }
}

function withRedactedErrors(operation) {
  return {
    ...operation,
    run: async (context) => {
      try {
        return await operation.run(context);
      } catch (operationError) {
        throw redactError(operationError, context.client.redact);
      }
    },
  };
}

export const pluginDefinition = createPluginDefinition();
