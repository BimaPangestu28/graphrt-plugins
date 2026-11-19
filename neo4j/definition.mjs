/**
 * neo4j plugin definition: Cypher over the Neo4j HTTP Query API v2 (https://neo4j.com/docs/query-api/current/), for
 * Neo4j 5.x/2025+ servers and Aura. Built with the declarative REST layer (docs/declarative-plugins.md).
 *
 * The server is NEO4J_URL (default http://localhost:7474; Aura: https://<id>.databases.neo4j.io) and the database
 * NEO4J_DATABASE (default neo4j); every query goes to POST /db/<database>/query/v2 with basic auth.
 *
 * Agent policy: `run_read_query` and the schema operations send `accessMode: "Read"`. The Query API documents that
 * field for routing, not as a guaranteed write barrier on a single server, so tool statements are scanned
 * (lib/cypher-tool-guard.mjs): read queries refuse write clauses, and every tool statement refuses side effects a read
 * transaction allows (LOAD CSV, APOC/dbms/genai procedures, TERMINATE, USE, SHOW TRANSACTIONS/SETTINGS). The real
 * protection is that guard plus a database user with a read-only role (README).
 * `run_write_query` (accessMode "Write") needs NEO4J_TOOL_ALLOW_WRITES=1; `delete_node` is node only.
 */
import { defineRestPlugin } from "./lib/shared/rest-plugin.mjs";
import { ALLOWED_PROCEDURES_ENV, guardToolStatements } from "./lib/cypher-tool-guard.mjs";
import { DATABASE_ENV, resolveDatabaseUrl, resolveServerUrl, URL_ENV, withRecords } from "./lib/neo4j-extras.mjs";

const QUERY_PATH = "/query/v2";
const QUERY_TIMEOUT_MS = 110000;
const statementParams = {
  statement: {
    in: "body",
    type: "string",
    required: true,
    minLength: 1,
    description: "Cypher statement on one line; pass values as $name placeholders in parameters, never inline",
  },
  parameters: { in: "body", type: "object", description: 'Values for $placeholders, e.g. {"name": "Alice", "limit": 10}' },
  max_execution_time: { in: "body", type: "integer", min: 1, max: 100, wireName: "maxExecutionTime", description: "Server-side transaction timeout in seconds (Neo4j 2026.04+)" },
};

/** A read-only query with a fixed statement (no user Cypher). */
const fixedReadQuery = ({ name, title, description, statement }) => ({
  name,
  title,
  description,
  method: "POST",
  path: QUERY_PATH,
  write: "idempotent",
  constants: { body: { statement, accessMode: "Read" } },
});

const queryOperations = [
  {
    name: "run_read_query",
    title: "Run read query",
    description:
      "Run a read-only Cypher query (accessMode Read; agent statements with write clauses are refused); rows are in records, one object per row keyed by the RETURN names",
    method: "POST",
    path: QUERY_PATH,
    // A read query changes nothing, so it may be retried (tool statements with write clauses never reach the server).
    write: "idempotent",
    timeoutMs: QUERY_TIMEOUT_MS,
    params: statementParams,
    constants: { body: { accessMode: "Read" } },
  },
  {
    name: "run_write_query",
    title: "Run write query",
    description: "Run a Cypher query that may write (CREATE, MERGE, SET, DELETE); counters say what changed",
    method: "POST",
    path: QUERY_PATH,
    write: "unsafe",
    checkHint: "run_read_query to see whether the change is already there",
    toolPolicy: "optIn:NEO4J_TOOL_ALLOW_WRITES",
    timeoutMs: QUERY_TIMEOUT_MS,
    params: statementParams,
    constants: { body: { accessMode: "Write", includeCounters: true } },
  },
];

const schemaOperations = [
  fixedReadQuery({ name: "list_labels", title: "List labels", description: "Node labels in the database (records[].label)", statement: "CALL db.labels() YIELD label RETURN label ORDER BY label" }),
  fixedReadQuery({
    name: "list_relationship_types",
    title: "List relationship types",
    description: "Relationship types in the database (records[].relationshipType)",
    statement: "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType",
  }),
  fixedReadQuery({
    name: "list_property_keys",
    title: "List property keys",
    description: "Property keys used in the database (records[].propertyKey)",
    statement: "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey",
  }),
  fixedReadQuery({
    name: "list_indexes",
    title: "List indexes",
    description: "Indexes (name, type, entityType, labelsOrTypes, properties, state), including full-text and vector indexes",
    statement: "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state RETURN name, type, entityType, labelsOrTypes, properties, state ORDER BY name",
  }),
  fixedReadQuery({
    name: "list_constraints",
    title: "List constraints",
    description: "Constraints (name, type, entityType, labelsOrTypes, properties)",
    statement: "SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name",
  }),
  fixedReadQuery({
    name: "get_schema",
    title: "Get schema",
    description: "Schema graph: which labels connect through which relationship types (records[0].nodes and relationships)",
    statement: "CALL db.schema.visualization()",
  }),
];

const elementIdParam = { in: "body", type: "string", required: true, minLength: 1, wireName: "parameters.element_id", description: "elementId of the node (from a query result)" };

const nodeOperations = [
  {
    name: "get_node",
    title: "Get node",
    description: "One node by elementId with its labels and properties (records[0].n; no records when missing)",
    method: "POST",
    path: QUERY_PATH,
    write: "idempotent",
    params: { element_id: elementIdParam },
    constants: { body: { statement: "MATCH (n) WHERE elementId(n) = $element_id RETURN n", accessMode: "Read" } },
  },
  {
    name: "delete_node",
    title: "Delete node",
    description: "Delete one node by elementId together with its relationships (DETACH DELETE); counters.nodesDeleted is 0 when it was missing",
    method: "POST",
    path: QUERY_PATH,
    write: "idempotent",
    nodeOnly: true,
    params: { element_id: elementIdParam },
    constants: { body: { statement: "MATCH (n) WHERE elementId(n) = $element_id DETACH DELETE n", accessMode: "Write", includeCounters: true } },
  },
];

const serverOperations = [
  {
    name: "get_server_info",
    title: "Server info",
    description: "Neo4j version, edition and the Query API versions the server offers (discovery, no auth needed)",
    baseUrl: resolveServerUrl,
    sendCredential: false,
    path: "/",
  },
];

const restDefinition = defineRestPlugin({
  name: "neo4j",
  version: "0.1.0",
  description:
    "Neo4j Cypher over the HTTP Query API v2: read queries (accessMode Read plus an agent statement guard), schema (labels, types, indexes, constraints), nodes by elementId; writes need an opt-in for agents, deletes are node only",
  apiName: "Neo4j Query API",
  baseUrl: resolveDatabaseUrl,
  auth: { type: "basic", userEnv: "NEO4J_USERNAME", passwordEnv: "NEO4J_PASSWORD" },
  extraEnv: [URL_ENV, DATABASE_ENV, ALLOWED_PROCEDURES_ENV],
  limits: { timeout_ms: 120000 },
  // Errors are {"errors": [{"code": "Neo.ClientError.Statement.SyntaxError", "message": "..."}]}. Failed queries can
  // also come back as 202 with that body, so errorPath catches them in a success status too.
  errors: {
    messagePath: ["errors.0.message"],
    codePath: "errors.0.code",
    errorPath: "errors.0",
    kindByCode: {
      "Neo.ClientError.Security.Unauthorized": "auth_error",
      "Neo.ClientError.Security.AuthenticationRateLimit": "rate_limited",
      "Neo.ClientError.Security.Forbidden": "permission_denied",
      "Neo.ClientError.Statement.AccessMode": "permission_denied",
      "Neo.ClientError.Statement.SyntaxError": "invalid_input",
      "Neo.ClientError.Statement.SemanticError": "invalid_input",
      "Neo.ClientError.Statement.ParameterMissing": "invalid_input",
      "Neo.ClientError.Statement.TypeError": "invalid_input",
      "Neo.ClientError.Statement.ArgumentError": "invalid_input",
      "Neo.ClientError.Request.Invalid": "invalid_input",
      "Neo.ClientError.Request.InvalidFormat": "invalid_input",
      "Neo.ClientError.Database.DatabaseNotFound": "not_found",
      "Neo.ClientError.Procedure.ProcedureNotFound": "not_found",
    },
    // The transaction was rolled back, so nothing was applied.
    retryableCodes: ["Neo.TransientError.Transaction.DeadlockDetected", "Neo.TransientError.Transaction.LockClientStopped", "Neo.TransientError.General.DatabaseUnavailable"],
  },
  // Everything goes through POST /query/v2; GET has nothing more to offer under /db/<database>.
  apiRequest: false,
  operations: [...queryOperations, ...schemaOperations, ...nodeOperations, ...serverOperations],
});

const QUERY_OPERATION_NAMES = [...queryOperations, ...schemaOperations, ...nodeOperations].map((operation) => operation.name);

export const pluginDefinition = withRecords(guardToolStatements(restDefinition, { read: ["run_read_query"], write: ["run_write_query"] }), QUERY_OPERATION_NAMES);
