//! Argument validation (port of `params.mjs`): the JSON-Schema subset operation schemas use (type, enum,
//! minimum/maximum, minLength, maxItems, items.type, default, required), with the same coercion of strings from
//! workflow templates and of numeric ids, and the same messages.

use serde_json::{Map, Value};

use crate::error::{invalid_argument, RestError};
use crate::js;

/// `validateArguments(schema, rawArguments)`: only declared properties, validated, defaults applied.
pub fn validate_arguments(schema: &Value, raw_arguments: &Value) -> Result<Map<String, Value>, RestError> {
    let empty = Map::new();
    let properties = schema.get("properties").and_then(Value::as_object).unwrap_or(&empty);
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |names| names.iter().filter_map(Value::as_str).collect());
    let mut validated = Map::new();
    for (name, property_schema) in properties {
        let raw_value = raw_arguments.as_object().and_then(|arguments| arguments.get(name));
        if is_missing(raw_value) {
            if required.contains(&name.as_str()) {
                return Err(invalid_argument(name, "is required"));
            }
            if let Some(default) = property_schema.get("default") {
                validated.insert(name.clone(), default.clone());
            }
            continue;
        }
        let value = validate_value(name, property_schema, raw_value.expect("not missing"))?;
        validated.insert(name.clone(), value);
    }
    Ok(validated)
}

fn is_missing(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null)) || value.and_then(Value::as_str) == Some("")
}

fn validate_value(name: &str, property_schema: &Value, raw_value: &Value) -> Result<Value, RestError> {
    let declared_type = property_schema.get("type").and_then(Value::as_str).unwrap_or("");
    let coerced = coerce_array_items(property_schema, coerce_value(declared_type, raw_value)?)?;
    let value = canonicalize_enum(property_schema.get("enum"), coerced);
    check_type(name, property_schema, &value)?;
    check_constraints(name, property_schema, &value)?;
    Ok(value)
}

// LLMs often send "post" for "POST"; accept a unique case-insensitive match.
fn canonicalize_enum(enum_values: Option<&Value>, value: Value) -> Value {
    let (Some(Value::Array(enum_values)), Value::String(text)) = (enum_values, &value) else {
        return value;
    };
    if enum_values.iter().any(|enum_value| enum_value.as_str() == Some(text)) {
        return value;
    }
    // ASCII folding: enum values are ASCII names (JavaScript also folds a few non-ASCII letters, e.g. U+212A).
    let matches: Vec<&Value> = enum_values
        .iter()
        .filter(|enum_value| enum_value.as_str().is_some_and(|candidate| candidate.eq_ignore_ascii_case(text)))
        .collect();
    match matches.as_slice() {
        [only] => (*only).clone(),
        _ => value,
    }
}

fn coerce_value(declared_type: &str, raw_value: &Value) -> Result<Value, RestError> {
    let text = match raw_value {
        Value::Number(number) => return coerce_number(declared_type, number),
        Value::String(text) => text,
        other => return Ok(other.clone()),
    };
    let trimmed = js::trim(text);
    if matches!(declared_type, "integer" | "number") && !trimmed.is_empty() {
        let number = js::parse_number(trimmed);
        if number.is_finite() {
            return Ok(js::number_value(number));
        }
    }
    if declared_type == "boolean" {
        match trimmed.to_ascii_lowercase().as_str() {
            "true" | "1" => return Ok(Value::Bool(true)),
            "false" | "0" => return Ok(Value::Bool(false)),
            _ => {}
        }
    }
    let is_json_text = (declared_type == "array" && trimmed.starts_with('['))
        || (declared_type == "object" && trimmed.starts_with('{'));
    if is_json_text {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return Ok(parsed);
        }
    }
    Ok(raw_value.clone())
}

// Numeric ids inside string arrays (e.g. `[123, 456]`) get the same exact-string treatment as scalars.
fn coerce_array_items(property_schema: &Value, value: Value) -> Result<Value, RestError> {
    let items_are_strings = property_schema.pointer("/items/type").and_then(Value::as_str) == Some("string");
    match value {
        Value::Array(items) if items_are_strings => items
            .into_iter()
            .map(|item| match &item {
                Value::Number(number) => coerce_number("string", number),
                _ => Ok(item),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        other => Ok(other),
    }
}

// IDs often arrive as numbers (unquoted YAML, LLM tool calls); keep them exact.
fn coerce_number(declared_type: &str, number: &serde_json::Number) -> Result<Value, RestError> {
    let float = number.as_f64().unwrap_or(f64::NAN);
    if declared_type == "boolean" && (float == 0.0 || float == 1.0) {
        return Ok(Value::Bool(float == 1.0));
    }
    if declared_type != "string" {
        return Ok(Value::Number(number.clone()));
    }
    let text = js::number_text(number);
    if float.fract() == 0.0 && float.abs() > js::MAX_SAFE_INTEGER {
        return Err(RestError::invalid_input(format!("Number {text} is too large to be exact; quote it as a string")));
    }
    Ok(Value::String(text))
}

fn is_integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|float| float.fract() == 0.0)
}

fn check_type(name: &str, property_schema: &Value, value: &Value) -> Result<(), RestError> {
    let declared_type = property_schema.get("type").and_then(Value::as_str).unwrap_or("");
    let is_valid = match declared_type {
        "string" => value.is_string(),
        "integer" => is_integer(value),
        "number" => value.is_number(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        _ => true,
    };
    if !is_valid {
        return Err(invalid_argument(name, &format!("must be of type {declared_type}")));
    }
    if let (Some(items), Some(item_schema)) =
        (value.as_array(), property_schema.get("items").filter(|items| items.get("type").is_some()))
    {
        for (index, item) in items.iter().enumerate() {
            check_type(&format!("{name}[{index}]"), item_schema, item)?;
        }
    }
    Ok(())
}

fn check_constraints(name: &str, property_schema: &Value, value: &Value) -> Result<(), RestError> {
    if let Some(Value::Array(enum_values)) = property_schema.get("enum") {
        if !enum_values.iter().any(|enum_value| same_value(enum_value, value)) {
            let choices: Vec<String> = enum_values.iter().map(js::to_text).collect();
            return Err(invalid_argument(name, &format!("must be one of {}", choices.join(", "))));
        }
    }
    let number = value.as_f64();
    if let (Some(minimum), Some(number)) = (property_schema.get("minimum").and_then(Value::as_f64), number) {
        if number < minimum {
            return Err(invalid_argument(name, &format!("must be >= {}", js::format_number(minimum))));
        }
    }
    if let (Some(maximum), Some(number)) = (property_schema.get("maximum").and_then(Value::as_f64), number) {
        if number > maximum {
            return Err(invalid_argument(name, &format!("must be <= {}", js::format_number(maximum))));
        }
    }
    let length = match value {
        Value::String(text) => Some(js::utf16_len(text)),
        Value::Array(items) => Some(items.len()),
        _ => None,
    };
    if let (Some(min_length), Some(length)) = (property_schema.get("minLength").and_then(Value::as_u64), length) {
        if (length as u64) < min_length {
            return Err(invalid_argument(name, &format!("must have at least {min_length} characters")));
        }
    }
    if let (Some(max_items), Some(length)) = (property_schema.get("maxItems").and_then(Value::as_u64), length) {
        if (length as u64) > max_items {
            return Err(invalid_argument(name, &format!("must have at most {max_items} items")));
        }
    }
    Ok(())
}

// `Array.prototype.includes` (SameValueZero) for JSON values: objects and arrays never match.
fn same_value(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64() == right.as_f64(),
        (Value::Array(_) | Value::Object(_), _) | (_, Value::Array(_) | Value::Object(_)) => false,
        _ => left == right,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coerces_and_checks_like_params_mjs() {
        let schema = json!({"properties": {
            "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25},
            "flag": {"type": "boolean"}, "id": {"type": "string"}, "method": {"type": "string", "enum": ["GET", "POST"]},
            "tags": {"type": "array", "items": {"type": "string"}}
        }, "required": []});
        let validated = validate_arguments(
            &schema,
            &json!({"limit": " 10 ", "flag": "TRUE", "id": 12, "method": "post", "tags": "[1, \"a\"]"}),
        )
        .unwrap();
        assert_eq!(
            Value::Object(validated),
            json!({"limit": 10, "flag": true, "id": "12", "method": "POST", "tags": ["1", "a"]})
        );
        assert_eq!(validate_arguments(&schema, &json!({})).unwrap().get("limit"), Some(&json!(25)));
        assert_eq!(validate_arguments(&schema, &json!({"limit": 0})).unwrap_err().message, "`limit` must be >= 1");
        assert_eq!(
            validate_arguments(&schema, &json!({"limit": 1.5})).unwrap_err().message,
            "`limit` must be of type integer"
        );
        assert_eq!(
            validate_arguments(&schema, &json!({"id": 9007199254740993u64})).unwrap_err().message,
            "Number 9007199254740992 is too large to be exact; quote it as a string"
        );
    }
}
