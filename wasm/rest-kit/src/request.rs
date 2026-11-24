//! Request building for one declarative operation (port of `rest-request.mjs`): path params as one encoded segment
//! each (`{+name}` keeps slashes), query params with array styles, header params (CR/LF refused), constants, the
//! generated `limit`/`cursor` under the API's own names, and JSON, raw, form or text bodies.

use serde_json::{Map, Value};

use crate::client::RequestOptions;
use crate::error::RestError;
use crate::js;
use crate::path::write_path;
use crate::url::{encode_uri_component, serialize_form, Url};

const JSON_TYPE: &str = "application/json";

#[derive(Default)]
struct Parts {
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    body: Map<String, Value>,
}

/// Whether the method has no body (GET, HEAD).
pub fn is_read_method(method: &str) -> bool {
    method == "GET" || method == "HEAD"
}

/// `buildRestRequest(operation, args, {baseUrl})`.
pub fn build_rest_request(
    operation: &Value,
    args: &Map<String, Value>,
    base_url: &str,
) -> Result<RequestOptions, RestError> {
    let method = operation["method"].as_str().unwrap_or("GET").to_owned();
    let empty = Map::new();
    let params = operation.get("params").and_then(Value::as_object).unwrap_or(&empty);
    let mut parts = Parts::default();
    for (name, param) in params {
        let location = param["in"].as_str().unwrap_or_default();
        if let Some(value) = args.get(name).filter(|_| location != "path") {
            place_param(&mut parts, param, value, name)?;
        }
    }
    apply_constants(operation.get("constants"), &mut parts)?;
    let cursor_url = apply_pagination_input(operation, args, &mut parts, base_url)?;
    let path = match cursor_url {
        Some(cursor_url) => cursor_url,
        None => append_query_string(fill_path_template(operation["path"].as_str().unwrap_or("/"), args)?, &parts.query),
    };
    let idempotent = match operation["write"].as_str().unwrap_or("read") {
        "idempotent" => Some(true),
        "unsafe" => Some(false),
        _ => None,
    };
    let mut request = RequestOptions { method, path, idempotent, ..RequestOptions::default() };
    for (name, value) in std::mem::take(&mut parts.headers) {
        request.headers.insert(name, value);
    }
    attach_body(operation, params, args, parts, &mut request);
    request.timeout_ms = operation.get("timeoutMs").and_then(Value::as_u64);
    Ok(request)
}

/// `fillPathTemplate`: `{name}` is one encoded segment, `{+name}` slash-separated encoded segments.
pub fn fill_path_template(template: &str, values: &Map<String, Value>) -> Result<String, RestError> {
    let mut path = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|offset| open + offset) else { break };
        let placeholder = &rest[open + 1..close];
        let (multi_segment, name) = match placeholder.strip_prefix('+') {
            Some(name) => (true, name),
            None => (false, placeholder),
        };
        if name.is_empty() || name.contains(['{', '+']) {
            path.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
            continue;
        }
        path.push_str(&rest[..open]);
        let value = values.get(name);
        if multi_segment {
            let text = value.filter(|value| !value.is_null()).map(js::to_text).unwrap_or_default();
            let segments = text
                .split('/')
                .map(|segment| path_segment(Some(&Value::String(segment.into()))))
                .collect::<Result<Vec<_>, _>>()?;
            path.push_str(&segments.join("/"));
        } else {
            path.push_str(&path_segment(value)?);
        }
        rest = &rest[close + 1..];
    }
    path.push_str(rest);
    Ok(path)
}

/// `pathSegment`: an id as one encoded path segment; empty, "." and ".." are refused.
pub fn path_segment(value: Option<&Value>) -> Result<String, RestError> {
    let segment = match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js::to_text(value),
    };
    if segment.is_empty() || segment == "." || segment == ".." {
        let shown = match value {
            None => "undefined".to_owned(),
            Some(value) => js::stringify(value),
        };
        return Err(RestError::invalid_input(format!("Invalid id {shown} in API path")));
    }
    Ok(encode_uri_component(&segment))
}

fn place_param(parts: &mut Parts, param: &Value, value: &Value, name: &str) -> Result<(), RestError> {
    let wire_name = param.get("wireName").and_then(Value::as_str).unwrap_or(name);
    match param["in"].as_str().unwrap_or_default() {
        "query" => append_query_value(
            &mut parts.query,
            wire_name,
            value,
            param.get("style").and_then(Value::as_str).unwrap_or("comma"),
        ),
        "header" => {
            let header_value = js::to_text(value);
            if header_value.contains(['\r', '\n', '\0']) {
                return Err(RestError::invalid_input(format!(
                    "`{name}` must not contain line breaks or NUL characters"
                )));
            }
            parts.headers.push((wire_name.to_ascii_lowercase(), header_value));
        }
        "body" => write_path(&mut parts.body, wire_name, value.clone())?,
        _ => {}
    }
    Ok(())
}

fn apply_constants(constants: Option<&Value>, parts: &mut Parts) -> Result<(), RestError> {
    let Some(constants) = constants else { return Ok(()) };
    for (name, value) in constants.get("query").and_then(Value::as_object).into_iter().flatten() {
        append_query_value(&mut parts.query, name, value, "comma");
    }
    for (path, value) in constants.get("body").and_then(Value::as_object).into_iter().flatten() {
        write_path(&mut parts.body, path, value.clone())?;
    }
    for (name, value) in constants.get("headers").and_then(Value::as_object).into_iter().flatten() {
        parts.headers.push((name.to_ascii_lowercase(), js::to_text(value)));
    }
    Ok(())
}

/// `appendQueryValue`: "comma" (a,b), "repeat" (k=a&k=b) or "brackets" (k[]=a&k[]=b).
pub fn append_query_value(entries: &mut Vec<(String, String)>, wire_name: &str, value: &Value, style: &str) {
    match value {
        Value::Null => {}
        Value::Array(items) if style != "comma" => {
            let repeated_name = if style == "brackets" { format!("{wire_name}[]") } else { wire_name.to_owned() };
            for item in items {
                entries.push((repeated_name.clone(), encode_scalar(item)));
            }
        }
        other => entries.push((wire_name.to_owned(), crate::client::encode_query_value(other))),
    }
}

fn encode_scalar(value: &Value) -> String {
    match value {
        Value::Object(_) | Value::Array(_) => js::stringify(value),
        other => js::to_text(other),
    }
}

fn append_query_string(path: String, entries: &[(String, String)]) -> String {
    if entries.is_empty() {
        return path;
    }
    format!("{path}?{}", serialize_form(entries))
}

// --- pagination input -------------------------------------------------------------------------------

fn apply_pagination_input(
    operation: &Value,
    args: &Map<String, Value>,
    parts: &mut Parts,
    base_url: &str,
) -> Result<Option<String>, RestError> {
    let Some(pagination) = operation.get("pagination").filter(|pagination| pagination.is_object()) else {
        return Ok(None);
    };
    let response = &operation["response"];
    let in_body = pagination["paramsIn"].as_str() == Some("body");
    let style = pagination["style"].as_str().unwrap_or_default();
    let cursor = args.get("cursor");
    let limit = args.get("limit");
    let mut place = |wire_name: Option<&str>, value: Option<Value>| -> Result<(), RestError> {
        let (Some(wire_name), Some(value)) = (wire_name, value) else { return Ok(()) };
        if in_body {
            write_path(&mut parts.body, wire_name, value)
        } else {
            append_query_value(&mut parts.query, wire_name, &value, "comma");
            Ok(())
        }
    };
    let field = |path: &str| response.pointer(path).and_then(Value::as_str);
    match style {
        "link" | "nextUrl" => {
            if let Some(cursor) = cursor {
                return check_next_url_cursor(&js::to_text(cursor), base_url).map(Some);
            }
            place(field("/limitParam"), limit.cloned())?;
        }
        "cursor" => {
            place(field("/cursorParam"), cursor.cloned())?;
            place(field("/limitParam"), limit.cloned())?;
        }
        "lastItem" => {
            place(field("/lastItemCursor/param"), cursor.cloned())?;
            place(field("/limitParam"), limit.cloned())?;
        }
        "page" => {
            let first_page = response.pointer("/pagePagination/firstPage").and_then(Value::as_f64).unwrap_or(1.0);
            let page = parse_page_cursor(cursor, first_page)?;
            place(field("/pagePagination/pageParam"), page)?;
            place(field("/pagePagination/sizeParam"), limit.cloned())?;
        }
        "offset" => {
            let offset = parse_page_cursor(cursor, 0.0)?;
            place(field("/offsetPagination/offsetParam"), offset)?;
            place(field("/offsetPagination/limitParam"), limit.cloned())?;
        }
        _ => {}
    }
    Ok(None)
}

/// `checkNextUrlCursor`: a next-page URL must stay on the API (same origin, under the base path).
pub fn check_next_url_cursor(cursor: &str, base_url: &str) -> Result<String, RestError> {
    let refuse = || {
        RestError::invalid_input(
            "`cursor` must be the next_cursor URL returned by an earlier call (on the API's own base URL)",
        )
    };
    let cursor_url = Url::parse(cursor).ok_or_else(refuse)?;
    let base = Url::parse(base_url).ok_or_else(refuse)?;
    let base_path = base.path.strip_suffix('/').unwrap_or(&base.path);
    let is_under_base = cursor_url.path == base_path || cursor_url.path.starts_with(&format!("{base_path}/"));
    if cursor_url.origin() != base.origin()
        || !is_under_base
        || !cursor_url.username.is_empty()
        || !cursor_url.password.is_empty()
    {
        return Err(refuse());
    }
    Ok(cursor_url.href())
}

fn parse_page_cursor(cursor: Option<&Value>, minimum: f64) -> Result<Option<Value>, RestError> {
    let Some(cursor) = cursor else { return Ok(None) };
    let page = js::to_number(cursor);
    if !(page.is_finite() && page.fract() == 0.0) || page < minimum {
        return Err(RestError::invalid_input(format!(
            "`cursor` must be a next_cursor value from an earlier call (an integer >= {})",
            js::format_number(minimum)
        )));
    }
    Ok(Some(js::number_value(page)))
}

// --- body -----------------------------------------------------------------------------------------------

fn attach_body(
    operation: &Value,
    params: &Map<String, Value>,
    args: &Map<String, Value>,
    parts: Parts,
    request: &mut RequestOptions,
) {
    if is_read_method(&request.method) {
        return;
    }
    let body_params: Vec<&String> =
        params.iter().filter(|(_, param)| param["in"].as_str() == Some("body")).map(|(name, _)| name).collect();
    let paginates_in_body = operation.pointer("/pagination/paramsIn").and_then(Value::as_str) == Some("body");
    let declares_body = !body_params.is_empty() || paginates_in_body || operation.pointer("/constants/body").is_some();
    if !declares_body {
        return;
    }
    let content_type = operation.get("contentType").and_then(Value::as_str);
    let first_body_value = body_params.first().and_then(|name| args.get(*name));
    let (body, default_type) = match operation["bodyMode"].as_str().unwrap_or("json") {
        "raw" => match first_body_value {
            Some(value) => (js::stringify(value), JSON_TYPE),
            None => return,
        },
        "text" => match first_body_value {
            Some(value) => (encode_text_body(value), "text/plain; charset=utf-8"),
            None => return,
        },
        "form" => {
            let style = operation.get("formArrays").and_then(Value::as_str).unwrap_or("brackets");
            let mut entries = Vec::new();
            flatten_form_value(&mut entries, "", &Value::Object(parts.body), style);
            request.headers.insert("content-type".into(), "application/x-www-form-urlencoded".into());
            request.body = Some(serialize_form(&entries));
            return;
        }
        _ => (js::stringify(&Value::Object(parts.body)), JSON_TYPE),
    };
    request.headers.insert("content-type".into(), content_type.unwrap_or(default_type).into());
    request.body = Some(body);
}

fn encode_text_body(value: &Value) -> String {
    match value {
        Value::Array(items) => items.iter().map(|item| format!("{}\n", js::stringify(item))).collect(),
        other => js::to_text(other),
    }
}

/// `flattenFormValue`: Stripe-style bracket keys (`metadata[order]`, `tags[]`, `items[0][price]`).
fn flatten_form_value(entries: &mut Vec<(String, String)>, prefix: &str, value: &Value, style: &str) {
    match value {
        Value::Null => {}
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let is_nested = item.is_object() || item.is_array();
                let key = if style == "indexed" || is_nested {
                    format!("{prefix}[{index}]")
                } else if style == "repeat" {
                    prefix.to_owned()
                } else {
                    format!("{prefix}[]")
                };
                flatten_form_value(entries, &key, item, style);
            }
        }
        Value::Object(map) => {
            for (key, nested) in map {
                let nested_key = if prefix.is_empty() { key.clone() } else { format!("{prefix}[{key}]") };
                flatten_form_value(entries, &nested_key, nested, style);
            }
        }
        other => entries.push((prefix.to_owned(), js::to_text(other))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fills_paths_and_queries() {
        let values = json!({"owner": "a b", "file": "dir/x y.md"});
        let values = values.as_object().unwrap();
        assert_eq!(
            fill_path_template("/repos/{owner}/contents/{+file}", values).unwrap(),
            "/repos/a%20b/contents/dir/x%20y.md"
        );
        assert_eq!(fill_path_template("/x/{missing}", values).unwrap_err().message, "Invalid id undefined in API path");
        let mut entries = Vec::new();
        append_query_value(&mut entries, "ids", &json!([1, 2]), "comma");
        append_query_value(&mut entries, "tag", &json!(["a", "b"]), "brackets");
        assert_eq!(append_query_string("/p".into(), &entries), "/p?ids=1%2C2&tag%5B%5D=a&tag%5B%5D=b");
    }
}
