//! Response shaping (port of `rest-response.mjs`): `dataPath` picks the data, the pagination style (cursor field,
//! Link header, next URL, last item id, page number or offset) gives `next_cursor`, passed through the request's
//! redaction; and agent tool results are cut to `maxItems` rows and `maxChars` characters.

use serde_json::{json, Map, Value};

use crate::client::Response;
use crate::js;
use crate::path::read_path;

/// An operation's result: `{data, next_cursor}`.
#[derive(Clone, Debug, PartialEq)]
pub struct OperationResult {
    pub data: Value,
    pub next_cursor: Value,
}

impl OperationResult {
    pub fn data(data: Value) -> Self {
        Self { data, next_cursor: Value::Null }
    }

    pub fn to_json(&self) -> Value {
        json!({"data": self.data, "next_cursor": self.next_cursor})
    }
}

/// `shapeRestResponse(operation, response, args)`.
pub fn shape_rest_response(operation: &Value, response: &Response, args: &Map<String, Value>) -> OperationResult {
    let data_path = operation.pointer("/response/dataPath").and_then(Value::as_str);
    let data = read_path(&response.body, data_path).cloned();
    let Some(style) = operation.pointer("/pagination/style").and_then(Value::as_str) else {
        return OperationResult::data(data.unwrap_or(Value::Null));
    };
    let next_cursor = find_next_cursor(style, &operation["response"], response, data.as_ref(), args);
    let next_cursor = match next_cursor {
        None | Some(Value::Null) => Value::Null,
        Some(cursor) => Value::String(crate::client::redact_text(&js::to_text(&cursor), &response.secrets)),
    };
    OperationResult { data: data.unwrap_or(Value::Null), next_cursor }
}

fn find_next_cursor(
    style: &str,
    spec: &Value,
    response: &Response,
    data: Option<&Value>,
    args: &Map<String, Value>,
) -> Option<Value> {
    let path = |pointer: &str| spec.pointer(pointer).and_then(Value::as_str);
    match style {
        "cursor" => {
            read_cursor_field(path("/cursorPath"), spec.get("hasMorePath").and_then(Value::as_str), &response.body)
        }
        "link" => response.headers.get("link").and_then(|header| parse_next_link(header)).map(Value::String),
        "nextUrl" => read_cursor_field(path("/nextUrlPath"), None, &response.body),
        "lastItem" => read_last_item_cursor(&spec["lastItemCursor"], &response.body, data),
        "page" => next_page(&spec["pagePagination"], &response.body, data, args),
        "offset" => next_offset(&spec["offsetPagination"], &response.body, data, args),
        _ => None,
    }
}

fn read_cursor_field(cursor_path: Option<&str>, has_more_path: Option<&str>, body: &Value) -> Option<Value> {
    if has_more_path.is_some() && !js::is_truthy(read_path(body, has_more_path)) {
        return None;
    }
    match read_path(body, cursor_path.or(Some(""))) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(cursor) => Some(cursor.clone()),
    }
}

fn read_last_item_cursor(spec: &Value, body: &Value, data: Option<&Value>) -> Option<Value> {
    let has_more_path = spec.get("hasMorePath").and_then(Value::as_str);
    if has_more_path.is_some() && !js::is_truthy(read_path(body, has_more_path)) {
        return None;
    }
    let last = data?.as_array()?.last()?;
    read_path(last, spec.get("itemIdPath").and_then(Value::as_str)).filter(|id| !id.is_null()).cloned()
}

/// `parseNextLink`: the rel="next" URL of an RFC 8288 Link header.
pub fn parse_next_link(header: &str) -> Option<String> {
    split_links(header).into_iter().find_map(|link| {
        let link = link.trim_start();
        let rest = link.strip_prefix('<')?;
        let close = rest.find('>')?;
        let (target, params) = (&rest[..close], &rest[close + 1..]);
        (!target.is_empty() && has_next_rel(params)).then(|| target.to_owned())
    })
}

// `header.split(/,(?=\s*<)/)`.
fn split_links(header: &str) -> Vec<&str> {
    let mut links = Vec::new();
    let mut start = 0;
    for (index, character) in header.char_indices() {
        if character == ',' && header[index + 1..].trim_start().starts_with('<') {
            links.push(&header[start..index]);
            start = index + 1;
        }
    }
    links.push(&header[start..]);
    links
}

// `/;\s*rel="?([^";]*\s)?next(\s[^";]*)?"?(;|$)/i`: a rel parameter whose value lists "next".
fn has_next_rel(params: &str) -> bool {
    params.split(';').skip(1).any(|param| {
        let param = param.trim_start();
        let Some(value) = param.get(..4).filter(|name| name.eq_ignore_ascii_case("rel=")).map(|_| &param[4..]) else {
            return false;
        };
        let unquoted = value.strip_prefix('"').unwrap_or(value);
        let unquoted = unquoted.split('"').next().unwrap_or(unquoted);
        unquoted.split_whitespace().any(|relation| relation.eq_ignore_ascii_case("next"))
    })
}

fn next_page(spec: &Value, body: &Value, data: Option<&Value>, args: &Map<String, Value>) -> Option<Value> {
    let first_page = spec.get("firstPage").and_then(Value::as_f64).unwrap_or(1.0);
    let current_page = args.get("cursor").map_or(first_page, js::to_number);
    if let Some(total_pages_path) = spec.get("totalPagesPath").and_then(Value::as_str) {
        let total_pages = read_path(body, Some(total_pages_path)).map_or(f64::NAN, js::to_number);
        return (total_pages.is_finite() && current_page - first_page + 1.0 < total_pages)
            .then(|| js::number_value(current_page + 1.0));
    }
    is_full_page(data, args.get("limit")).then(|| js::number_value(current_page + 1.0))
}

fn next_offset(spec: &Value, body: &Value, data: Option<&Value>, args: &Map<String, Value>) -> Option<Value> {
    let items = data?.as_array()?;
    let next_start = args.get("cursor").map_or(0.0, js::to_number) + items.len() as f64;
    if let Some(total_path) = spec.get("totalPath").and_then(Value::as_str) {
        let total = read_path(body, Some(total_path)).map_or(f64::NAN, js::to_number);
        return (total.is_finite() && next_start < total).then(|| js::number_value(next_start));
    }
    is_full_page(data, args.get("limit")).then(|| js::number_value(next_start))
}

// Without a known page size any non-empty page may have a successor; an empty page ends the listing.
fn is_full_page(data: Option<&Value>, limit: Option<&Value>) -> bool {
    let Some(items) = data.and_then(Value::as_array).filter(|items| !items.is_empty()) else { return false };
    limit.is_none_or(|limit| items.len() as f64 >= js::to_number(limit))
}

/// `truncateForTool(data, toolOutput)`: arrays to `maxItems`, then the JSON text to `maxChars`.
pub fn truncate_for_tool(data: Value, tool_output: &Value) -> Value {
    if *tool_output == Value::Bool(false) || data.is_null() {
        return data;
    }
    let max_items = tool_output.get("maxItems").and_then(Value::as_u64).map(|max| max as usize);
    let shortened = match data {
        Value::Array(mut items) if max_items.is_some_and(|max| items.len() > max) => {
            let total = items.len();
            items.truncate(max_items.unwrap_or(total));
            json!({"truncated": true, "items": items, "total_items": total})
        }
        other => other,
    };
    let Some(max_chars) = tool_output.get("maxChars").and_then(Value::as_u64).map(|max| max as usize) else {
        return shortened;
    };
    let text = js::stringify(&shortened);
    let length = js::utf16_len(&text);
    if length <= max_chars {
        return shortened;
    }
    json!({"truncated": true, "preview": js::utf16_prefix(&text, max_chars), "total_chars": length})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_next_links() {
        let header =
            r#"<https://api.example.com/x?page=1>; rel="prev", <https://api.example.com/x?page=2>; rel="next""#;
        assert_eq!(parse_next_link(header).as_deref(), Some("https://api.example.com/x?page=2"));
        assert_eq!(parse_next_link(r#"<https://a/x>; rel="first next""#).as_deref(), Some("https://a/x"));
        assert_eq!(parse_next_link(r#"<https://a/x>; rel=nextish"#), None);
    }

    #[test]
    fn truncates_tool_results() {
        let rows = Value::Array((0..5).map(Value::from).collect());
        assert_eq!(
            truncate_for_tool(rows, &json!({"maxItems": 2})),
            json!({"truncated": true, "items": [0, 1], "total_items": 5})
        );
        let long = json!({"a": "x".repeat(20)});
        assert_eq!(
            truncate_for_tool(long, &json!({"maxChars": 10})),
            json!({"truncated": true, "preview": "{\"a\":\"xxxx", "total_chars": 28})
        );
    }
}
