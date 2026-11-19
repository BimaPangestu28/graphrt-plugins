/**
 * The `$` keys agent tool calls may send: aggregation stages, query and
 * projection operators, update operators, aggregation expression, accumulator
 * and window operators, and Extended JSON type wrappers.
 *
 * It is an allowlist on purpose: MongoDB keeps adding operators (and has
 * undocumented `$_internal…` ones that run JavaScript), so anything not
 * listed here is refused for tool calls. Server-side JavaScript (`$where`,
 * `$function`, `$accumulator`, `$code`) is deliberately absent.
 */

/** Pipeline stages a tool call may use ($merge is checked separately; $out never). */
export const TOOL_STAGES = new Set([
  "$addFields", "$bucket", "$bucketAuto", "$count", "$densify", "$documents", "$facet", "$fill", "$geoNear", "$graphLookup",
  "$group", "$limit", "$lookup", "$match", "$project", "$redact", "$replaceRoot", "$replaceWith", "$sample", "$set",
  "$setWindowFields", "$skip", "$sort", "$sortByCount", "$unionWith", "$unset", "$unwind",
]);

const QUERY_OPERATORS = [
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$and", "$or", "$nor", "$not", "$exists", "$type", "$regex", "$options",
  "$all", "$elemMatch", "$size", "$mod", "$expr", "$jsonSchema", "$text", "$search", "$language", "$caseSensitive",
  "$diacriticSensitive", "$comment", "$geoWithin", "$geoIntersects", "$near", "$nearSphere", "$geometry", "$box", "$center",
  "$centerSphere", "$polygon", "$maxDistance", "$minDistance", "$bitsAllSet", "$bitsAllClear", "$bitsAnySet", "$bitsAnyClear",
  "$sampleRate", "$slice", "$meta",
];

const UPDATE_OPERATORS = [
  "$set", "$unset", "$inc", "$mul", "$rename", "$min", "$max", "$currentDate", "$setOnInsert", "$push", "$addToSet", "$pop",
  "$pull", "$pullAll", "$each", "$position", "$sort", "$slice", "$bit", "$xor",
];

const EXPRESSION_OPERATORS = [
  // arithmetic
  "$abs", "$add", "$ceil", "$divide", "$exp", "$floor", "$ln", "$log", "$log10", "$multiply", "$pow", "$round", "$sqrt", "$subtract", "$trunc",
  // array
  "$arrayElemAt", "$arrayToObject", "$concatArrays", "$filter", "$first", "$firstN", "$indexOfArray", "$isArray", "$last", "$lastN",
  "$map", "$maxN", "$minN", "$objectToArray", "$range", "$reduce", "$reverseArray", "$sortArray", "$zip",
  // comparison, boolean, conditional
  "$cmp", "$cond", "$ifNull", "$switch",
  // dates
  "$dateAdd", "$dateDiff", "$dateFromParts", "$dateFromString", "$dateSubtract", "$dateToParts", "$dateToString", "$dateTrunc",
  "$dayOfMonth", "$dayOfWeek", "$dayOfYear", "$hour", "$isoDayOfWeek", "$isoWeek", "$isoWeekYear", "$millisecond", "$minute",
  "$month", "$second", "$toDate", "$week", "$year", "$tsIncrement", "$tsSecond",
  // misc, objects, variables
  "$literal", "$getField", "$setField", "$unsetField", "$let", "$rand", "$mergeObjects", "$binarySize", "$bsonSize",
  // sets
  "$allElementsTrue", "$anyElementTrue", "$setDifference", "$setEquals", "$setIntersection", "$setIsSubset", "$setUnion",
  // strings
  "$concat", "$indexOfBytes", "$indexOfCP", "$ltrim", "$regexFind", "$regexFindAll", "$regexMatch", "$replaceOne", "$replaceAll",
  "$rtrim", "$split", "$strLenBytes", "$strLenCP", "$strcasecmp", "$substr", "$substrBytes", "$substrCP", "$toLower", "$toString",
  "$trim", "$toUpper",
  // trigonometry
  "$sin", "$cos", "$tan", "$asin", "$acos", "$atan", "$atan2", "$asinh", "$acosh", "$atanh", "$sinh", "$cosh", "$tanh",
  "$degreesToRadians", "$radiansToDegrees",
  // types
  "$convert", "$isNumber", "$toBool", "$toDecimal", "$toDouble", "$toInt", "$toLong", "$toObjectId",
  // accumulators and window operators ($accumulator is JavaScript and not listed)
  "$avg", "$bottom", "$bottomN", "$count", "$median", "$percentile", "$stdDevPop", "$stdDevSamp", "$sum", "$top", "$topN",
  "$covariancePop", "$covarianceSamp", "$denseRank", "$derivative", "$documentNumber", "$expMovingAvg", "$integral",
  "$linearFill", "$locf", "$rank", "$shift",
];

const EXTENDED_JSON_KEYS = [
  "$oid", "$date", "$numberDecimal", "$numberLong", "$numberInt", "$numberDouble", "$binary", "$base64", "$subType", "$uuid",
  "$timestamp", "$t", "$i", "$regularExpression", "$pattern", "$minKey", "$maxKey", "$ref", "$id", "$db",
];

/** Every `$` key a tool call may use anywhere in a filter, projection, sort, update, document or pipeline. */
export const TOOL_OPERATORS = new Set([...TOOL_STAGES, ...QUERY_OPERATORS, ...UPDATE_OPERATORS, ...EXPRESSION_OPERATORS, ...EXTENDED_JSON_KEYS]);

/** Server-side JavaScript, named in error messages. */
export const JAVASCRIPT_OPERATORS = new Set(["$where", "$function", "$accumulator", "$code", "$codeWithScope"]);
