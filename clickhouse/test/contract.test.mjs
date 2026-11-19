import assert from "node:assert/strict";
import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const SERVER = "https://ch.example.com:8443";
const PASSWORD = "contract-clickhouse-password";

describeRestPluginContract(pluginDefinition, {
  environment: { CLICKHOUSE_URL: SERVER, CLICKHOUSE_USER: "analyst", CLICKHOUSE_PASSWORD: PASSWORD },
  checkAuth: (call) => {
    assert.equal(call.headers["x-clickhouse-user"], "analyst");
    assert.equal(call.headers["x-clickhouse-key"], PASSWORD);
  },
  operations: {
    ping: {
      args: {},
      request: { method: "GET", url: `${SERVER}/ping`, query: "absent" },
    },
    server_info: {
      args: {},
      request: {
        method: "GET",
        url: `${SERVER}/`,
        query: { query: "SELECT version() AS version, uptime() AS uptime_seconds, timezone() AS timezone, currentUser() AS current_user, currentDatabase() AS current_database FORMAT JSON" },
      },
      response: { body: { meta: [], data: [{ version: "25.10.1" }], rows: 1 } },
      expect: { data: [{ version: "25.10.1" }] },
    },
    list_databases: {
      args: {},
      request: { method: "GET", url: `${SERVER}/`, query: { query: "SELECT name, engine, comment FROM system.databases ORDER BY name FORMAT JSON" } },
    },
    list_tables: {
      args: { database: "analytics" },
      request: {
        method: "GET",
        url: `${SERVER}/`,
        query: {
          param_database: "analytics",
          query: "SELECT name, engine, total_rows, total_bytes, sorting_key, comment FROM system.tables WHERE database = {database:String} AND NOT is_temporary ORDER BY name FORMAT JSON",
        },
      },
    },
    describe_table: {
      args: { table: "events" },
      request: {
        method: "GET",
        url: `${SERVER}/`,
        query: {
          param_database: "default",
          param_table: "events",
          query:
            "SELECT name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key FROM system.columns WHERE database = {database:String} AND table = {table:String} ORDER BY position FORMAT JSON",
        },
      },
    },
  },
});
