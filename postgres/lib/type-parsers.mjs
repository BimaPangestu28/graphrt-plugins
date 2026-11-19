/**
 * PostgreSQL value parsing and type names.
 *
 * pg already returns int8 and numeric as strings, bytea as Buffer, json as
 * objects and timestamptz as Date. Two of its defaults lose information, so
 * they are replaced here:
 * - `timestamp` (no time zone) would be read as the plugin's local time; it is
 *   returned as written, in ISO form ("2026-11-19T10:00:00.123456").
 * - `timestamptz` would lose microseconds in a Date; it is returned as ISO text
 *   with the server's offset ("2026-11-19T10:00:00.123456+07:00").
 * `date`, `time` and `timetz` stay as the server writes them.
 */

const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
const TEXT_KEPT_OIDS = new Set([1082, 1083, 1266]);
const ARRAY_ELEMENT_OIDS = new Map([[1115, TIMESTAMP_OID], [1185, TIMESTAMPTZ_OID], [1182, 1082], [1183, 1083], [1270, 1266]]);
const TYPE_NAMES_BY_OID = new Map([
  [16, "bool"], [17, "bytea"], [18, "char"], [19, "name"], [20, "int8"], [21, "int2"], [23, "int4"], [25, "text"], [26, "oid"],
  [114, "json"], [142, "xml"], [700, "float4"], [701, "float8"], [790, "money"], [869, "inet"], [650, "cidr"], [829, "macaddr"],
  [1000, "bool[]"], [1001, "bytea[]"], [1005, "int2[]"], [1007, "int4[]"], [1009, "text[]"], [1016, "int8[]"], [1021, "float4[]"],
  [1022, "float8[]"], [1015, "varchar[]"], [1042, "bpchar"], [1043, "varchar"], [1082, "date"], [1083, "time"], [1114, "timestamp"],
  [1115, "timestamp[]"], [1182, "date[]"], [1184, "timestamptz"], [1185, "timestamptz[]"], [1186, "interval"], [1231, "numeric[]"],
  [1266, "timetz"], [1700, "numeric"], [2950, "uuid"], [2951, "uuid[]"], [3802, "jsonb"], [3807, "jsonb[]"], [199, "json[]"],
  [3904, "int4range"], [3926, "int8range"], [3912, "daterange"], [3910, "tstzrange"], [3908, "tsrange"], [3614, "tsvector"],
  [1560, "bit"], [1562, "varbit"], [2249, "record"], [2278, "void"], [705, "unknown"],
]);

/**
 * Converts a `timestamp`/`timestamptz` text value to ISO 8601 without losing precision.
 *
 * @param timestampText - Value as PostgreSQL writes it, e.g. "2026-11-19 10:00:00.5+07" (string)
 * @returns ISO text, e.g. "2026-11-19T10:00:00.5+07:00"; "infinity" and BC dates are returned unchanged (string)
 */
export function normalizeTimestampText(timestampText) {
  if (!/^\d{4,}-\d{2}-\d{2} /.test(timestampText) || timestampText.endsWith(" BC")) return timestampText;
  return timestampText.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
}

/**
 * Builds the `types` object handed to pg (pool queries and cursors).
 *
 * @param pgTypes - pg's `types` export (`{getTypeParser, arrayParser}`) (object)
 * @returns `{getTypeParser(oid, format)}` (object)
 */
export function createTypeParsers(pgTypes) {
  const parseScalarText = (oid) => (oid === TIMESTAMP_OID || oid === TIMESTAMPTZ_OID ? normalizeTimestampText : (text) => text);
  return {
    getTypeParser(oid, format = "text") {
      if (format !== "text") return pgTypes.getTypeParser(oid, format);
      if (oid === TIMESTAMP_OID || oid === TIMESTAMPTZ_OID || TEXT_KEPT_OIDS.has(oid)) return parseScalarText(oid);
      const elementOid = ARRAY_ELEMENT_OIDS.get(oid);
      if (elementOid) return (arrayText) => pgTypes.arrayParser.create(arrayText, parseScalarText(elementOid)).parse();
      return pgTypes.getTypeParser(oid, format);
    },
  };
}

/**
 * Describes a result column for the `fields` output.
 *
 * @param field - pg field description `{name, dataTypeID}` (object)
 * @returns `{name, type}`; unknown types are named "oid:<number>" (object)
 */
export function describeField(field) {
  return { name: field.name, type: TYPE_NAMES_BY_OID.get(field.dataTypeID) ?? `oid:${field.dataTypeID}` };
}
