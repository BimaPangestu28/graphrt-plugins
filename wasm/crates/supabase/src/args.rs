//! Tool argument validation against the tool's JSON schema (port of the shared
//! `validateArguments`): defaults, coercion of template strings and LLM numbers, enum,
//! minimum/maximum, minLength, maxItems, items.type and required, in schema order.

use graphrt_wasm_guest::serde_json::{self, Map, Number};
use graphrt_wasm_guest::{PluginError, Value};

use crate::js;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Validated arguments: only declared properties, defaults applied.
pub type Arguments = Map<String, Value>;

/// Validate `raw` against an object `schema`.
pub fn validate(schema: &Value, raw: &Value) -> Result<Arguments, PluginError> {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut validated = Map::new();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Ok(validated);
    };
    for (name, property) in properties {
        let value = raw.get(name).filter(|value| !is_missing(value));
        let Some(value) = value else {
            if required.contains(&name.as_str()) {
                return Err(invalid_argument(name, "is required"));
            }
            if let Some(default) = property.get("default") {
                validated.insert(name.clone(), default.clone());
            }
            continue;
        };
        validated.insert(name.clone(), validate_value(name, property, value.clone())?);
    }
    Ok(validated)
}

fn is_missing(value: &Value) -> bool {
    value.is_null() || value.as_str() == Some("")
}

fn declared_type(property: &Value) -> &str {
    property
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn validate_value(name: &str, property: &Value, raw: Value) -> Result<Value, PluginError> {
    let coerced = coerce_value(declared_type(property), raw)?;
    let value = canonicalize_enum(property.get("enum"), coerce_array_items(property, coerced)?);
    check_type(name, property, &value)?;
    check_constraints(name, property, &value)?;
    Ok(value)
}

// LLMs often send "post" for "POST"; accept a unique case-insensitive match.
fn canonicalize_enum(options: Option<&Value>, value: Value) -> Value {
    let (Some(options), Some(text)) = (options.and_then(Value::as_array), value.as_str()) else {
        return value;
    };
    if options.iter().any(|option| option.as_str() == Some(text)) {
        return value;
    }
    // ASCII case: the enums are ASCII (a non-ASCII spelling such as the Kelvin sign is refused, not mapped).
    let lower = text.to_ascii_lowercase();
    let matches: Vec<&Value> = options
        .iter()
        .filter(|option| {
            option
                .as_str()
                .is_some_and(|candidate| candidate.to_ascii_lowercase() == lower)
        })
        .collect();
    match matches.as_slice() {
        [only] => (*only).clone(),
        _ => value,
    }
}

fn coerce_value(declared: &str, raw: Value) -> Result<Value, PluginError> {
    match raw {
        Value::Number(number) => coerce_number(declared, &number),
        Value::String(text) => Ok(coerce_text(declared, text)),
        other => Ok(other),
    }
}

fn coerce_text(declared: &str, text: String) -> Value {
    let trimmed = text.trim();
    if matches!(declared, "integer" | "number") && !trimmed.is_empty() {
        if let Some(number) = js::parse_number(trimmed).filter(|n| n.is_finite()) {
            return number_value(number);
        }
    }
    if declared == "boolean" {
        match trimmed.to_ascii_lowercase().as_str() {
            "true" | "1" => return Value::Bool(true),
            "false" | "0" => return Value::Bool(false),
            _ => {}
        }
    }
    let json_like = (declared == "array" && trimmed.starts_with('['))
        || (declared == "object" && trimmed.starts_with('{'));
    if json_like {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return parsed;
        }
    }
    Value::String(text)
}

/// A JavaScript number as JSON: whole numbers as integers, like `JSON.stringify` writes them.
fn number_value(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER {
        // Exact: whole and within 2^53.
        #[allow(clippy::cast_possible_truncation)]
        return Value::Number(Number::from(number as i64));
    }
    Number::from_f64(number).map_or(Value::Null, Value::Number)
}

// Numeric ids inside string arrays (e.g. `[123, 456]`) get the same exact-string treatment as scalars.
fn coerce_array_items(property: &Value, value: Value) -> Result<Value, PluginError> {
    let items_are_strings = property.get("items").map(declared_type) == Some("string");
    match value {
        Value::Array(items) if items_are_strings => items
            .into_iter()
            .map(|item| match item {
                Value::Number(number) => coerce_number("string", &number),
                other => Ok(other),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        other => Ok(other),
    }
}

// IDs often arrive as numbers (unquoted YAML, LLM tool calls); keep them exact.
fn coerce_number(declared: &str, number: &Number) -> Result<Value, PluginError> {
    let numeric = number.as_f64().unwrap_or(f64::NAN);
    if declared == "boolean" && (numeric == 0.0 || numeric == 1.0) {
        return Ok(Value::Bool(numeric == 1.0));
    }
    if declared != "string" {
        return Ok(Value::Number(number.clone()));
    }
    if numeric.fract() == 0.0 && numeric.abs() > MAX_SAFE_INTEGER {
        return Err(PluginError::invalid_input(format!(
            "Number {} is too large to be exact; quote it as a string",
            js::json_number_string(number)
        )));
    }
    Ok(Value::String(js::json_number_string(number)))
}

fn check_type(name: &str, property: &Value, value: &Value) -> Result<(), PluginError> {
    let declared = declared_type(property);
    let valid = match declared {
        "string" => value.is_string(),
        "integer" => value.as_f64().is_some_and(|n| n.fract() == 0.0),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => true,
    };
    if !valid {
        return Err(invalid_argument(
            name,
            &format!("must be of type {declared}"),
        ));
    }
    if let (Some(items), Value::Array(values)) = (property.get("items"), value) {
        if !declared_type(items).is_empty() {
            for (index, item) in values.iter().enumerate() {
                check_type(&format!("{name}[{index}]"), items, item)?;
            }
        }
    }
    Ok(())
}

fn check_constraints(name: &str, property: &Value, value: &Value) -> Result<(), PluginError> {
    if let Some(options) = property.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            let shown: Vec<String> = options.iter().map(js::value_string).collect();
            return Err(invalid_argument(
                name,
                &format!("must be one of {}", shown.join(", ")),
            ));
        }
    }
    let numeric = value.as_f64();
    if let (Some(minimum), Some(number)) =
        (property.get("minimum").and_then(Value::as_f64), numeric)
    {
        if number < minimum {
            return Err(invalid_argument(
                name,
                &format!("must be >= {}", js::number_string(minimum)),
            ));
        }
    }
    if let (Some(maximum), Some(number)) =
        (property.get("maximum").and_then(Value::as_f64), numeric)
    {
        if number > maximum {
            return Err(invalid_argument(
                name,
                &format!("must be <= {}", js::number_string(maximum)),
            ));
        }
    }
    let length = match value {
        Value::String(text) => Some(text.encode_utf16().count()),
        Value::Array(items) => Some(items.len()),
        _ => None,
    };
    if let (Some(minimum), Some(length)) =
        (property.get("minLength").and_then(Value::as_u64), length)
    {
        if (length as u64) < minimum {
            return Err(invalid_argument(
                name,
                &format!("must have at least {minimum} characters"),
            ));
        }
    }
    if let (Some(maximum), Some(length)) =
        (property.get("maxItems").and_then(Value::as_u64), length)
    {
        if (length as u64) > maximum {
            return Err(invalid_argument(
                name,
                &format!("must have at most {maximum} items"),
            ));
        }
    }
    Ok(())
}

pub fn invalid_argument(name: &str, problem: &str) -> PluginError {
    PluginError::invalid_input(format!("`{name}` {problem}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use graphrt_wasm_guest::json;

    fn schema() -> Value {
        json!({"type": "object", "properties": {
            "table": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 100},
            "method": {"type": "string", "enum": ["GET", "POST"], "default": "GET"},
            "filters": {"type": "array", "items": {"type": "object"}, "maxItems": 2},
            "upsert": {"type": "boolean", "default": false},
        }, "required": ["table"]})
    }

    #[test]
    fn coerces_and_defaults_like_the_node_runner() {
        let args = validate(
            &schema(),
            &json!({"table": 7, "limit": " 10 ", "method": "post", "upsert": "1", "extra": 1}),
        )
        .unwrap();
        assert_eq!(
            Value::Object(args),
            json!({"table": "7", "limit": 10, "method": "POST", "upsert": true})
        );
    }

    #[test]
    fn reports_the_first_problem_in_schema_order() {
        let error = validate(&schema(), &json!({"limit": 0})).unwrap_err();
        assert_eq!(error.message, "`table` is required");
        let error = validate(&schema(), &json!({"table": "t", "limit": 0})).unwrap_err();
        assert_eq!(error.message, "`limit` must be >= 1");
        let error = validate(&schema(), &json!({"table": "t", "filters": [1]})).unwrap_err();
        assert_eq!(error.message, "`filters[0]` must be of type object");
        let error = validate(&schema(), &json!({"table": 9007199254740993_u64})).unwrap_err();
        assert!(error.message.contains("too large"), "{}", error.message);
    }
}
