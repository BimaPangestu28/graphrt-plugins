import { describeRestPluginContract } from "../lib/shared/rest-plugin-testing.mjs";
import { pluginDefinition } from "../definition.mjs";

const SERVER = "https://abcd1234.databases.neo4j.io";
const QUERY_URL = `${SERVER}/db/movies/query/v2`;
const fixedRead = (statement) => ({
  args: {},
  request: { method: "POST", url: QUERY_URL, query: "absent", json: { statement, accessMode: "Read" } },
});

describeRestPluginContract(pluginDefinition, {
  environment: { NEO4J_URL: SERVER, NEO4J_DATABASE: "movies" },
  operations: {
    run_read_query: {
      args: { statement: "MATCH (p:Person {name: $name}) RETURN p.name AS name, p.born AS born", parameters: { name: "Keanu" }, max_execution_time: 30 },
      request: {
        method: "POST",
        url: QUERY_URL,
        query: "absent",
        json: { statement: "MATCH (p:Person {name: $name}) RETURN p.name AS name, p.born AS born", parameters: { name: "Keanu" }, maxExecutionTime: 30, accessMode: "Read" },
      },
      response: { status: 202, body: { data: { fields: ["name", "born"], values: [["Keanu", 1964]] }, bookmarks: ["FB:x"], queryType: "r" } },
      expect: { data: { records: [{ name: "Keanu", born: 1964 }], fields: ["name", "born"], bookmarks: ["FB:x"], queryType: "r" } },
    },
    run_write_query: {
      args: { statement: "MERGE (p:Person {name: $name}) RETURN p", parameters: { name: "Ada" } },
      request: { method: "POST", url: QUERY_URL, query: "absent", json: { statement: "MERGE (p:Person {name: $name}) RETURN p", parameters: { name: "Ada" }, accessMode: "Write", includeCounters: true } },
    },
    list_labels: fixedRead("CALL db.labels() YIELD label RETURN label ORDER BY label"),
    list_relationship_types: fixedRead("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType"),
    list_property_keys: fixedRead("CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey"),
    list_indexes: fixedRead("SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state RETURN name, type, entityType, labelsOrTypes, properties, state ORDER BY name"),
    list_constraints: fixedRead("SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name"),
    get_schema: fixedRead("CALL db.schema.visualization()"),
    get_node: {
      args: { element_id: "4:ff04:0" },
      request: { method: "POST", url: QUERY_URL, query: "absent", json: { parameters: { element_id: "4:ff04:0" }, statement: "MATCH (n) WHERE elementId(n) = $element_id RETURN n", accessMode: "Read" } },
    },
    delete_node: {
      args: { element_id: "4:ff04:0" },
      request: {
        method: "POST",
        url: QUERY_URL,
        query: "absent",
        json: { parameters: { element_id: "4:ff04:0" }, statement: "MATCH (n) WHERE elementId(n) = $element_id DETACH DELETE n", accessMode: "Write", includeCounters: true },
      },
    },
    get_server_info: {
      args: {},
      request: { method: "GET", url: `${SERVER}/`, query: "absent" },
      response: { body: { neo4j_version: "2026.10.0", neo4j_edition: "enterprise" } },
      expect: { data: { neo4j_version: "2026.10.0", neo4j_edition: "enterprise" } },
    },
  },
});
