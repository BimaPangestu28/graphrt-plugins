//! Safe PostgREST query building (port of `supabase/lib/postgrest-query.mjs`): structured
//! filters become one `and=(c1.op."v1",...)` group with every value quoted, and `order` is
//! checked term by term.

use graphrt_wasm_guest::{PluginError, Value};

use crate::js;

/// PostgREST horizontal filter operators, in the Node.js plugin's order.
pub const FILTER_OPERATORS: &[&str] = &[
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "ilike",
    "match",
    "imatch",
    "in",
    "is",
    "isdistinct",
    "fts",
    "plfts",
    "phfts",
    "wfts",
    "cs",
    "cd",
    "ov",
    "sl",
    "sr",
    "nxr",
    "nxl",
    "adj",
];
const FULL_TEXT_OPERATORS: &[&str] = &["fts", "plfts", "phfts", "wfts"];
const IS_KEYWORDS: &[&str] = &["null", "true", "false", "unknown"];
const MAX_FILTERS: usize = 20;

/// The value of the `and` query parameter, or `None` for no filters.
pub fn build_filter_expression(filters: &[Value]) -> Result<Option<String>, PluginError> {
    if filters.is_empty() {
        return Ok(None);
    }
    if filters.len() > MAX_FILTERS {
        return Err(invalid(format!(
            "`filters` may have at most {MAX_FILTERS} conditions"
        )));
    }
    let encoded = filters
        .iter()
        .enumerate()
        .map(|(index, filter)| encode_filter(filter, &format!("filters[{index}]")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(format!("({})", encoded.join(","))))
}

fn encode_filter(filter: &Value, label: &str) -> Result<String, PluginError> {
    let Some(fields) = filter.as_object() else {
        return Err(invalid(format!(
            "`{label}` must be an object {{column, operator, value}}"
        )));
    };
    let column = fields.get("column");
    match column.and_then(Value::as_str) {
        Some(name) if is_column(name) => {}
        _ => {
            let shown = column.map_or_else(|| "undefined".to_owned(), js::json_text);
            return Err(invalid(format!(
                "`{label}.column` must be a column name (letters, digits, _; JSON paths with -> or ->>), got {shown}"
            )));
        }
    }
    let operator = fields
        .get("operator")
        .and_then(Value::as_str)
        .filter(|op| FILTER_OPERATORS.contains(op));
    let Some(operator) = operator else {
        return Err(invalid(format!(
            "`{label}.operator` must be one of {}",
            FILTER_OPERATORS.join(", ")
        )));
    };
    let prefix = if fields.get("negate") == Some(&Value::Bool(true)) {
        "not."
    } else {
        ""
    };
    let operator_text = encode_operator(operator, fields.get("language"), label)?;
    let operand = encode_operand(operator, fields.get("value"), label)?;
    Ok(format!(
        "{}.{prefix}{operator_text}.{operand}",
        column.and_then(Value::as_str).unwrap_or_default()
    ))
}

fn encode_operator(
    operator: &str,
    language: Option<&Value>,
    label: &str,
) -> Result<String, PluginError> {
    let Some(language) = language else {
        return Ok(operator.to_owned());
    };
    if !FULL_TEXT_OPERATORS.contains(&operator) {
        return Err(invalid(format!(
            "`{label}.language` is only for fts, plfts, phfts and wfts"
        )));
    }
    match language.as_str() {
        Some(name)
            if !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') =>
        {
            Ok(format!("{operator}({name})"))
        }
        _ => Err(invalid(format!(
            "`{label}.language` must be a text search configuration name such as english"
        ))),
    }
}

fn encode_operand(
    operator: &str,
    value: Option<&Value>,
    label: &str,
) -> Result<String, PluginError> {
    if operator == "is" {
        let keyword = match value {
            None => "undefined".to_owned(),
            Some(value) => js::value_string(value).to_ascii_lowercase(),
        };
        if IS_KEYWORDS.contains(&keyword.as_str()) {
            return Ok(keyword);
        }
        return Err(invalid(format!(
            "`{label}.value` for is must be null, true, false or unknown"
        )));
    }
    if operator == "in" {
        let items = value
            .and_then(Value::as_array)
            .filter(|items| !items.is_empty());
        let Some(items) = items else {
            return Err(invalid(format!(
                "`{label}.value` for in must be a non-empty list of values"
            )));
        };
        let quoted = items
            .iter()
            .enumerate()
            .map(|(index, item)| quote_scalar(Some(item), &format!("{label}.value[{index}]")))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(format!("({})", quoted.join(",")));
    }
    if value == Some(&Value::Null) {
        return Err(invalid(format!(
            "`{label}.value` is null: use operator is with null"
        )));
    }
    quote_scalar(value, &format!("{label}.value"))
}

/// `"value"` with `\` and `"` escaped, for a string, number or boolean.
fn quote_scalar(value: Option<&Value>, label: &str) -> Result<String, PluginError> {
    match value {
        Some(scalar @ (Value::String(_) | Value::Number(_) | Value::Bool(_))) => {
            let text = js::value_string(scalar)
                .replace('\\', "\\\\")
                .replace('"', "\\\"");
            Ok(format!("\"{text}\""))
        }
        _ => Err(invalid(format!(
            "`{label}` must be a string, number or boolean value"
        ))),
    }
}

/// `order`: comma-separated `column[.asc|.desc][.nullsfirst|.nullslast]` terms, spaces around terms removed.
pub fn validate_order(order: &str) -> Result<String, PluginError> {
    let terms: Vec<&str> = order.split(',').map(str::trim).collect();
    if terms.iter().all(|term| is_order_term(term)) {
        return Ok(terms.join(","));
    }
    Err(invalid(
        "`order` must be comma-separated column[.asc|.desc][.nullsfirst|.nullslast] terms, e.g. created_at.desc,id".into(),
    ))
}

fn is_order_term(term: &str) -> bool {
    let column_end = column_length(term);
    if column_end == 0 {
        return false;
    }
    let mut rest = &term[column_end..];
    for options in [["asc", "desc"], ["nullsfirst", "nullslast"]] {
        if let Some(after) = options
            .iter()
            .find_map(|option| rest.strip_prefix('.')?.strip_prefix(option))
        {
            rest = after;
        }
    }
    rest.is_empty()
}

/// `^[\p{L}_][\p{L}\p{N}_$]*(->>?[\p{L}\p{N}_]+)*$`
fn is_column(text: &str) -> bool {
    let length = column_length(text);
    length > 0 && length == text.len()
}

/// Length in bytes of the longest column name (with JSON arrows) at the start of `text`; 0 when none.
fn column_length(text: &str) -> usize {
    let mut chars = text.char_indices().peekable();
    match chars.next() {
        Some((_, first)) if first.is_alphabetic() || first == '_' => {}
        _ => return 0,
    }
    let mut end = text.len();
    while let Some(&(index, character)) = chars.peek() {
        if character.is_alphanumeric() || character == '_' || character == '$' {
            chars.next();
            continue;
        }
        end = index;
        break;
    }
    if chars.peek().is_none() {
        return text.len();
    }
    end + json_arrows_length(&text[end..])
}

/// Length of `(->>?[\p{L}\p{N}_]+)*` at the start of `text`.
fn json_arrows_length(text: &str) -> usize {
    let mut consumed = 0;
    loop {
        let rest = &text[consumed..];
        let Some(after_arrow) = rest.strip_prefix("->") else {
            return consumed;
        };
        let after_arrow = after_arrow.strip_prefix('>').unwrap_or(after_arrow);
        let key_length: usize = after_arrow
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .map(char::len_utf8)
            .sum();
        if key_length == 0 {
            return consumed;
        }
        consumed = text.len() - after_arrow.len() + key_length;
    }
}

fn invalid(message: String) -> PluginError {
    PluginError::invalid_input(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use graphrt_wasm_guest::json;

    #[test]
    fn filters_are_quoted() {
        let filters = [
            json!({"column": "status", "operator": "eq", "value": "a,\"b\""}),
            json!({"column": "data->>city", "operator": "in", "value": ["x", 2]}),
            json!({"column": "deleted_at", "operator": "is", "value": null, "negate": true}),
            json!({"column": "body", "operator": "fts", "value": "cat", "language": "english"}),
        ];
        assert_eq!(
            build_filter_expression(&filters).unwrap().unwrap(),
            r#"(status.eq."a,\"b\"",data->>city.in.("x","2"),deleted_at.not.is.null,body.fts(english)."cat")"#
        );
        let bad =
            build_filter_expression(&[json!({"column": "a;drop", "operator": "eq", "value": 1})])
                .unwrap_err();
        assert!(bad.message.contains("got \"a;drop\""), "{}", bad.message);
    }

    #[test]
    fn order_terms_are_checked() {
        assert_eq!(
            validate_order(" created_at.desc , id.asc.nullslast").unwrap(),
            "created_at.desc,id.asc.nullslast"
        );
        assert_eq!(validate_order("data->>n.desc").unwrap(), "data->>n.desc");
        assert!(validate_order("id;select").is_err());
        assert!(validate_order("id.nullslast.desc").is_err());
    }
}
