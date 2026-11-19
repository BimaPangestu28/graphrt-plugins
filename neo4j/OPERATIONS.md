# neo4j operations

Generated from `definition.mjs` by `npm run sync` — do not edit by hand.

Each operation is a node `neo4j.<operation>` (outputs `data`, `next_cursor`) and a tool `<operation>`.
Nodes also accept an optional `access_token`. **Bold** parameters are required.

| Operation | Description | Parameters |
|-----------|-------------|------------|
| `run_read_query` | Run a read-only Cypher query (accessMode Read; agent statements with write clauses are refused); rows are in records, one object per row keyed by the RETURN names | **statement**, parameters, max_execution_time |
| `run_write_query` | Run a Cypher query that may write (CREATE, MERGE, SET, DELETE); counters say what changed (as an agent tool only when NEO4J_TOOL_ALLOW_WRITES=1) | **statement**, parameters, max_execution_time |
| `list_labels` | Node labels in the database (records[].label) |  |
| `list_relationship_types` | Relationship types in the database (records[].relationshipType) |  |
| `list_property_keys` | Property keys used in the database (records[].propertyKey) |  |
| `list_indexes` | Indexes (name, type, entityType, labelsOrTypes, properties, state), including full-text and vector indexes |  |
| `list_constraints` | Constraints (name, type, entityType, labelsOrTypes, properties) |  |
| `get_schema` | Schema graph: which labels connect through which relationship types (records[0].nodes and relationships) |  |
| `get_node` | One node by elementId with its labels and properties (records[0].n; no records when missing) | **element_id** |
| `delete_node` | Delete one node by elementId together with its relationships (DETACH DELETE); counters.nodesDeleted is 0 when it was missing | **element_id** |
| `get_server_info` | Neo4j version, edition and the Query API versions the server offers (discovery, no auth needed) |  |
