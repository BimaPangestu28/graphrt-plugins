import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, createOperationRunner } from "../lib/shared/operations.mjs";
import { createRecordingFetch } from "../lib/shared/testing.mjs";
import { findToolStatementProblems, stripCypherNoise } from "../lib/cypher-tool-guard.mjs";
import { resolveDatabaseUrl, resolveServerUrl, zipRecords } from "../lib/neo4j-extras.mjs";
import { pluginDefinition } from "../definition.mjs";

const SERVER = "https://abcd1234.databases.neo4j.io";
const baseEnvironment = { NEO4J_URL: SERVER, NEO4J_USERNAME: "neo4j", NEO4J_PASSWORD: "pw-secret-1" };

async function run(operationName, args, { source = "tool", environment = {}, responses = [{ status: 202, body: { data: { fields: [], values: [] } } }] } = {}) {
  const recordingFetch = createRecordingFetch(responses);
  const runner = createOperationRunner(pluginDefinition, { ...baseEnvironment, ...environment }, { fetchImpl: recordingFetch });
  return { result: await runner(operationName, args, { source }), calls: recordingFetch.calls };
}

const deniedTool = (error) => error.kind === "permission_denied";

test("stripCypherNoise drops comments and string contents and unquotes backtick names", () => {
  assert.equal(stripCypherNoise("MATCH (n) // CALL apoc.x()\nRETURN 'LOAD CSV', \"it\\\"s\", `a`.b /* USE x */"), "MATCH (n)  \nRETURN '', '',  a .b  ");
  assert.equal(stripCypherNoise("RETURN n.`use`"), "RETURN n.use ");
  assert.equal(stripCypherNoise("RETURN `we``ird`"), "RETURN  we`ird ");
});

test("plain reads, allowed built-ins and allowed SHOW commands pass the tool guard", () => {
  const allowed = [
    "MATCH (p:Person)-[:ACTED_IN]->(m) WHERE p.name = $name RETURN m.title, count(*) AS c ORDER BY c DESC LIMIT 5",
    "CALL db.labels() YIELD label RETURN label",
    "CALL db.index.vector.queryNodes('emb', 5, $vector) YIELD node, score RETURN node.title, score",
    "RETURN point.distance(point({x: 1, y: 2}), point({x: 0, y: 0})), date.truncate('month', date())",
    "SHOW RANGE INDEXES",
    "SHOW ALL CONSTRAINTS",
    "MATCH (n) CALL (n) { RETURN n.name AS name } RETURN name",
    "MATCH (n) RETURN n.username AS user, 'LOAD CSV FROM x' AS text",
  ];
  for (const statement of allowed) assert.deepEqual(findToolStatementProblems(statement), [], statement);
});

test("side effects a read transaction allows are refused for tools", () => {
  const refused = {
    "LOAD CSV FROM 'https://evil.example/x.csv' AS row RETURN row": "LOAD CSV",
    "load  csv with headers from 'file:///etc/passwd' as r return r": "LOAD CSV",
    "CALL apoc.load.json('https://evil.example') YIELD value RETURN value": "apoc.load.json",
    "CALL `apoc`.`load`.json('x')": "apoc.load.json",
    "CALL apoc . export . csv . all('/tmp/x.csv', {})": "apoc.export.csv.all",
    "RETURN apoc.cypher.runFirstColumnSingle('MATCH (n) RETURN n', {})": "apoc.cypher.runfirstcolumnsingle",
    "RETURN genai.vector.encode('text', 'OpenAI', {token: $t})": "genai.vector.encode",
    "CALL dbms.killQuery('query-1')": "dbms.killquery",
    "TERMINATE TRANSACTIONS 'neo4j-transaction-1'": "TERMINATE",
    "SHOW TRANSACTIONS": "SHOW",
    "SHOW SETTINGS YIELD name, value": "SHOW",
    "USE system SHOW USERS": "USE",
    "CALL myproc()": "myproc",
    "MATCH (n) /* hide */ CALL/**/apoc.periodic.iterate('a','b',{}) RETURN n": "apoc.periodic.iterate",
  };
  for (const [statement, expected] of Object.entries(refused)) {
    const problems = findToolStatementProblems(statement);
    assert.ok(problems.some((problem) => problem.includes(expected)), `${statement} -> ${problems.join("; ")}`);
  }
});

test("NEO4J_TOOL_ALLOWED_PROCEDURES adds exact names and prefixes", () => {
  assert.deepEqual(findToolStatementProblems("RETURN apoc.coll.sum([1, 2])", "apoc.coll."), []);
  assert.deepEqual(findToolStatementProblems("RETURN apoc.text.join(['a'], ',')", "apoc.text.*"), []);
  assert.deepEqual(findToolStatementProblems("CALL gds.pageRank.stream('g')", "gds.pagerank.stream"), []);
  assert.notDeepEqual(findToolStatementProblems("CALL apoc.load.json('x')", "apoc.coll."), []);
});

test("tool queries are guarded; workflow nodes run any statement", async () => {
  const statement = "CALL apoc.load.json('https://evil.example') YIELD value RETURN value";
  await assert.rejects(run("run_read_query", { statement }), (error) => deniedTool(error) && error.message.includes("NEO4J_TOOL_ALLOWED_PROCEDURES"));
  const { calls } = await run("run_read_query", { statement }, { source: "node" });
  assert.equal(calls.length, 1);
});

test("read queries always send accessMode Read, and a server AccessMode refusal is permission_denied", async () => {
  const { calls } = await run("run_read_query", { statement: "MATCH (n) RETURN count(n) AS c" });
  assert.equal(calls[0].json.accessMode, "Read");
  const accessModeError = { status: 202, body: { errors: [{ code: "Neo.ClientError.Statement.AccessMode", message: "Writing in read access mode not allowed." }] } };
  await assert.rejects(run("run_read_query", { statement: "CREATE (n:X) RETURN n" }, { source: "node", responses: [accessModeError] }), (error) => deniedTool(error) && error.message.includes("Writing in read access mode not allowed."));
});

test("write queries need NEO4J_TOOL_ALLOW_WRITES=1 for tools and keep the guard", async () => {
  const statement = "CREATE (n:Note {text: $text}) RETURN n";
  await assert.rejects(run("run_write_query", { statement, parameters: { text: "x" } }), (error) => deniedTool(error) && error.message.includes("NEO4J_TOOL_ALLOW_WRITES"));
  const { calls } = await run("run_write_query", { statement }, { environment: { NEO4J_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(calls[0].json.accessMode, "Write");
  await assert.rejects(run("run_write_query", { statement: "LOAD CSV FROM 'https://x' AS r CREATE (:R)" }, { environment: { NEO4J_TOOL_ALLOW_WRITES: "1" } }), deniedTool);
});

test("delete_node is not an agent tool and there is no api_request", () => {
  const toolNames = buildManifest(pluginDefinition).tools.map((tool) => tool.name);
  assert.equal(toolNames.includes("delete_node"), false);
  assert.equal(toolNames.includes("api_request"), false);
  assert.equal(toolNames.includes("run_read_query"), true);
});

test("errors in a 202 body and 401s map to kinds; the password is redacted", async () => {
  const syntax = { status: 202, body: { errors: [{ code: "Neo.ClientError.Statement.SyntaxError", message: "Invalid input 'MATC'" }] } };
  await assert.rejects(run("run_read_query", { statement: "MATC (n) RETURN n" }, { responses: [syntax] }), (error) => error.kind === "invalid_input" && error.message.includes("Neo.ClientError.Statement.SyntaxError"));
  const unauthorized = { status: 401, body: { errors: [{ code: "Neo.ClientError.Security.Unauthorized", message: "Invalid username or password pw-secret-1." }] } };
  await assert.rejects(run("list_labels", {}, { responses: [unauthorized] }), (error) => error.kind === "auth_error" && !error.message.includes("pw-secret-1"));
});

test("basic auth is sent to queries but not to the unauthenticated discovery endpoint", async () => {
  const query = await run("list_labels", {});
  assert.equal(query.calls[0].headers.authorization, `Basic ${Buffer.from("neo4j:pw-secret-1").toString("base64")}`);
  const discovery = await run("get_server_info", {}, { responses: [{ body: { neo4j_version: "2026.10.0" } }] });
  assert.equal(discovery.calls[0].headers.authorization, undefined);
});

test("NEO4J_URL and NEO4J_DATABASE are validated", async () => {
  assert.equal(resolveDatabaseUrl({}), "http://localhost:7474/db/neo4j");
  assert.equal(resolveServerUrl({ NEO4J_URL: "https://x.databases.neo4j.io/" }), "https://x.databases.neo4j.io");
  assert.throws(() => resolveServerUrl({ NEO4J_URL: "neo4j+s://x.databases.neo4j.io" }), /HTTP\(S\)/);
  assert.throws(() => resolveDatabaseUrl({ NEO4J_DATABASE: "../system" }), /database name/);
  await assert.rejects(run("list_labels", {}, { environment: { NEO4J_URL: "http://10.1.2.3:7474" } }), (error) => error.kind === "invalid_input");
});

test("zipRecords turns fields and values into one object per row", () => {
  assert.deepEqual(zipRecords({ data: { fields: ["a", "b"], values: [[1, 2], [3, null]] }, bookmarks: ["x"] }), { records: [{ a: 1, b: 2 }, { a: 3, b: null }], fields: ["a", "b"], bookmarks: ["x"] });
  assert.deepEqual(zipRecords({ neo4j_version: "1" }), { neo4j_version: "1" });
});

// --- regression probes from the B12 review: comment, whitespace and backtick bypasses ---------------------------

function assertRefused(probes) {
  for (const [statement, expected] of Object.entries(probes)) {
    const problems = findToolStatementProblems(statement);
    assert.ok(problems.some((problem) => problem.includes(expected)), `${JSON.stringify(statement)} -> ${problems.join("; ")}`);
  }
}

test("a // comment ends at \\r as in Cypher, so a statement after it is still scanned", () => {
  assertRefused({
    "MATCH (n) // c\rCALL apoc.load.json('https://attacker.example/') YIELD value RETURN value": "apoc.load.json",
    "MATCH (n) // c\r\nUSE system SHOW USERS": "USE",
  });
});

test("Cypher whitespace outside JS \\s (U+001C..U+001F, U+0085) and other non-ASCII characters cannot hide keywords", () => {
  for (const separator of ["\u001c", "\u001d", "\u001e", "\u001f", "\u0085", " ", " ", "​", "\u0000", "\u007f", "\u000b", "\u000c"]) {
    assertRefused({
      [`LOAD${separator}CSV FROM 'https://x.example/a.csv' AS r RETURN r`]: "LOAD CSV",
      [`CALL${separator}apoc.load.json${separator}('https://x.example') YIELD value RETURN value`]: "apoc.load.json",
      [`RETURN apoc${separator}.${separator}cypher.runFirstColumnSingle('x', {})`]: "apoc.cypher.runfirstcolumnsingle",
      [`USE${separator}system SHOW USERS`]: "USE",
      [`TERMINATE${separator}TRANSACTIONS 'x'`]: "TERMINATE",
      [`SHOW${separator}TRANSACTIONS`]: "SHOW",
    });
  }
});

test("unquoting a backtick name never glues it onto the keyword before it", () => {
  assertRefused({
    "USE`system` SHOW USERS": "USE",
    "CALL`dbms.listConfig`() YIELD name RETURN name": "dbms.listconfig",
    "CALL`apoc`.`load`.`json`('x') YIELD value RETURN value": "apoc.load.json",
    "RETURN`apoc.cypher.runFirstColumnSingle`('x', {})": "apoc.cypher.runfirstcolumnsingle",
  });
});

test("block comments cannot hide keywords", () => {
  assertRefused({
    "LOAD/**/CSV FROM 'x' AS r RETURN r": "LOAD CSV",
    "USE/* x */system SHOW USERS": "USE",
    "CALL/*\n*/apoc.load.json('x')": "apoc.load.json",
  });
});

test("backslashes outside string literals (escape sequences in names) are refused", () => {
  assertRefused({ "CALL \\u0061poc.load.json('x')": "backslash", "RETURN `\\u0061poc`.load.json('x')": "backslash" });
  assert.deepEqual(findToolStatementProblems("RETURN 'it\\'s' AS text, \"a\\\\b\" AS path"), []);
});

test("use as a map key or property is not mistaken for the USE clause", () => {
  assert.deepEqual(findToolStatementProblems("RETURN {use: 1, create: 2} AS m"), []);
  assert.deepEqual(findToolStatementProblems("MATCH (n) WHERE n.use = 1 RETURN n.`use`"), []);
});

test("INSERT (a Cypher write clause) is refused in read-only statements", () => {
  for (const statement of ["INSERT (n:Person {name: 'x'})", "MATCH (a) INSERT (a)-[:KNOWS]->(b:Person)", "INSERT\u001c(n)"]) {
    assert.ok(findToolStatementProblems(statement, "", { readOnly: true }).some((problem) => problem.includes("write clause")), statement);
  }
});

test("keywords used as labels, relationship types or aliases are not mistaken for clauses", () => {
  const reads = [
    "MATCH (n:Create) RETURN n",
    "MATCH (n:`Set`) RETURN n",
    "MATCH (a)-[r:DELETE]->(b) RETURN r",
    "MATCH (a)-[: Merge]->(b) RETURN a",
    "RETURN 1 AS remove",
    "UNWIND [1, 2] AS insert RETURN 1 AS `create`",
    "MATCH (n:Use) RETURN n",
    "MATCH (n:Terminate:Show) WHERE n:Drop RETURN n",
    "MATCH (n) WHERE n IS :: STRING RETURN n",
    "WITH 1 AS x RETURN x AS Detach",
  ];
  for (const statement of reads) {
    assert.deepEqual(findToolStatementProblems(statement, "", { readOnly: true }), [], statement);
  }
});

test("known limitation: a variable named like a write keyword is refused where it is used (documented)", () => {
  for (const statement of ["MATCH (set) RETURN set", "UNWIND [1] AS remove RETURN remove"]) {
    assert.ok(findToolStatementProblems(statement, "", { readOnly: true }).some((problem) => problem.includes("write clause")), statement);
  }
  assert.deepEqual(findToolStatementProblems("MATCH (`set`) RETURN `set`", "", { readOnly: true }), []);
});

test("label and alias exceptions never let a real clause through", () => {
  const writes = [
    "MATCH (n:Person) CREATE (m)",
    "MATCH (n) WHERE n:Person SET n.x = 1",
    "WITH 1 AS `as` CREATE (m)",
    "WITH 1 AS `x` SET n.y = 1",
    "MATCH (n:`Person`) DELETE n",
    "WITH 1 AS x\u001cCREATE (m)",
    "UNWIND [1] AS create CREATE (m)",
    "MATCH (n) WITH n AS has CREATE (m)",
    "MATCH (n) WITH n.as AS y MERGE (m)",
    "RETURN n.as\nSET n.x = 1",
    "MATCH (n) FOREACH (x IN [1] | CREATE (:Y))",
  ];
  for (const statement of writes) {
    assert.ok(findToolStatementProblems(statement, "", { readOnly: true }).some((problem) => problem.includes("write clause")), statement);
  }
  assertRefused({
    "MATCH (n) WITH n AS x CALL apoc.load.json('x') YIELD value RETURN value": "apoc.load.json",
    "WITH 1 AS\u001cCALL apoc.load.json('x') YIELD value RETURN value": "apoc.load.json",
    "WITH 1 AS `use` USE system SHOW USERS": "USE",
    "MATCH (n:Person) USE system RETURN 1": "USE",
    "MATCH (n:Person) SHOW TRANSACTIONS": "SHOW",
  });
});

test("run_read_query refuses write clauses for tools, since accessMode Read is not a guaranteed server-side barrier", async () => {
  const writes = [
    "CREATE (n:X) RETURN n",
    "MATCH (n) SET n.flag = true",
    "MATCH (n) DETACH DELETE n",
    "MERGE (n:X {k: 1})",
    "MATCH (n) REMOVE n:Label",
    "MATCH (n) FOREACH (x IN [1] | CREATE (:Y))",
    "DROP INDEX idx",
    "CREATE\u001cINDEX idx FOR (n:X) ON (n.k)",
    "GRANT ROLE admin TO agent",
    "MATCH (n) CALL (n) { SET n.x = 1 } IN TRANSACTIONS",
  ];
  for (const statement of writes) {
    await assert.rejects(run("run_read_query", { statement }), (error) => deniedTool(error) && error.message.includes("write"), statement);
  }
  const { calls } = await run("run_read_query", { statement: "MATCH (n) WHERE n.created > 1 RETURN {set: n.merge} AS m, 'CREATE' AS word" });
  assert.equal(calls.length, 1);
  const writeQuery = await run("run_write_query", { statement: "CREATE (n:X) RETURN n" }, { environment: { NEO4J_TOOL_ALLOW_WRITES: "1" } });
  assert.equal(writeQuery.calls.length, 1);
});
