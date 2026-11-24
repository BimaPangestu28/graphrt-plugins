//! The default tool mode (port of `supabase/definition.mjs` as the Node.js runner serves it to
//! agents): every tool of the Node.js plugin except `download_object` (a module has no file
//! system), with the same schemas (`tools.jsonl`, checked against the Node.js manifest by the
//! parity tests), argument validation, agent policy, requests, results and errors.
//!
//! Agent policy: reads are tools; inserts, updates, upserts, uploads and function calls need
//! `SUPABASE_TOOL_ALLOW_WRITES=1`; uploads never overwrite; `api_request` only reads (GET) /rest/v1
//! and Storage (plus `SUPABASE_TOOL_API_EXTRA_PATHS`); `call_function` follows
//! `SUPABASE_TOOL_RPC_ALLOWLIST`, `SUPABASE_TOOL_TIMEOUT_MS` and `SUPABASE_TOOL_MAX_ROWS`.

use graphrt_wasm_guest::serde_json::{self, Map};
use graphrt_wasm_guest::{json, PluginError, ToolCall, ToolResult, Value};

use crate::args::{self, Arguments};
use crate::client::{ApiRequest, Body, Client, DEFAULT_TIMEOUT_MS};
use crate::settings::{self, RpcToolSettings};
use crate::{env_of, js, limits, postgrest, upload, url};

/// The tools' names, descriptions and parameter schemas, as in the Node.js manifest: one JSON
/// object per line, so a call parses only its own tool's line.
const TOOLS_JSONL: &str = include_str!("tools.jsonl");
const WRITES_ENV: &str = "SUPABASE_TOOL_ALLOW_WRITES";
const RETURN_PREFERENCE: &str = "return=representation,missing=default";
const UNKNOWN_OUTCOME_MARKER: &str = "outcome unknown";

/// `[{name, description, parameters}]` of every tool.
pub fn tool_specs() -> Vec<Value> {
    TOOLS_JSONL
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// The spec of tool `name`.
fn tool_spec(name: &str) -> Option<Value> {
    let prefix = format!(
        "{{\"name\":{},",
        js::json_text(&Value::String(name.to_owned()))
    );
    let line = TOOLS_JSONL.lines().find(|line| line.starts_with(&prefix))?;
    serde_json::from_str(line).ok()
}

/// A tool's result before it becomes `{data, next_cursor}`.
struct Output {
    data: Value,
    next_cursor: Option<String>,
}

impl Output {
    fn data(data: Value) -> Self {
        Self {
            data,
            next_cursor: None,
        }
    }
}

/// One tool call: mode, tool, arguments, credential, project URL, then the tool's own checks.
pub fn call_tool(call: &ToolCall) -> Result<ToolResult, PluginError> {
    settings::require_default_mode(env_of(call, settings::MODE_ENV))?;
    let spec = tool_spec(&call.name)
        .ok_or_else(|| PluginError::invalid_input(format!("Unknown operation `{}`", call.name)))?;
    let arguments = args::validate(
        spec.get("parameters").unwrap_or(&Value::Null),
        &call.arguments,
    )?;
    let client = Client::from_env(call)?;
    let output = run_tool(&call.name, &arguments, &client, call)?;
    Ok(ToolResult::json(
        json!({ "data": output.data, "next_cursor": output.next_cursor }),
    ))
}

fn run_tool(
    name: &str,
    args: &Arguments,
    client: &Client,
    call: &ToolCall,
) -> Result<Output, PluginError> {
    let env = |name: &str| env_of(call, name);
    match name {
        "get_api_schema" => read(
            client,
            get("/rest/v1/".into(), args, &[("db_schema", "accept-profile")])?,
        ),
        "select_rows" => select_rows(client, args),
        "insert_rows" => insert_rows(client, args, env),
        "upsert_rows" => upsert_rows(client, args, env),
        "update_rows" => update_rows(client, args, env),
        "call_function" => call_function(client, args, env),
        "list_buckets" => read(client, get("/storage/v1/bucket".into(), args, &[])?),
        "get_bucket" => {
            let path = format!("/storage/v1/bucket/{}", segment(args.get("bucket_id"))?);
            read(client, get(path, args, &[])?)
        }
        "list_objects" => list_objects(client, args),
        "get_object_info" => {
            let path = format!(
                "/storage/v1/object/info/authenticated/{}/{}",
                segment(args.get("bucket_id"))?,
                segments(args.get("object_path"))?
            );
            read(client, get(path, args, &[])?)
        }
        "upload_object" => upload_object(client, args, env),
        "api_request" => api_request(client, args, env),
        _ => Err(PluginError::invalid_input(format!(
            "Unknown operation `{name}`"
        ))),
    }
}

// --- reads -----------------------------------------------------------------------------------------

fn get(
    path: String,
    args: &Arguments,
    header_params: &[(&str, &str)],
) -> Result<ApiRequest, PluginError> {
    let mut request = ApiRequest::new("GET", path);
    place_headers(&mut request, args, header_params)?;
    Ok(request)
}

/// A read whose result gets the tool size cap.
fn read(client: &Client, request: ApiRequest) -> Result<Output, PluginError> {
    Ok(Output::data(limits::truncate_for_tool(
        client.send(request)?,
        None,
    )))
}

fn select_rows(client: &Client, args: &Arguments) -> Result<Output, PluginError> {
    let filters = filter_expression(args, None)?;
    let order = args
        .get("order")
        .map(|order| postgrest::validate_order(&js::value_string(order)))
        .transpose()?;
    let mut query = Vec::new();
    push_query(&mut query, "select", args.get("columns"));
    push_query(&mut query, "and", filters.map(Value::String).as_ref());
    push_query(&mut query, "order", order.map(Value::String).as_ref());
    let mut request = ApiRequest::new("GET", String::new());
    place_headers(&mut request, args, &[("db_schema", "accept-profile")])?;
    let offset = place_offset_pagination(args, &mut query, &mut |_, _| {})?;
    request.path = with_query(format!("/rest/v1/{}", segment(args.get("table"))?), &query);
    paginated(client, request, args, offset)
}

fn list_objects(client: &Client, args: &Arguments) -> Result<Output, PluginError> {
    let mut body = Map::new();
    for (param, wire_path) in [
        ("prefix", &["prefix"][..]),
        ("search", &["search"]),
        ("sort_column", &["sortBy", "column"]),
        ("sort_order", &["sortBy", "order"]),
    ] {
        if let Some(value) = args.get(param) {
            write_path(&mut body, wire_path, value.clone());
        }
    }
    let offset = place_offset_pagination(args, &mut Vec::new(), &mut |name, value| {
        write_path(&mut body, &[name], value);
    })?;
    let path = format!(
        "/storage/v1/object/list/{}",
        segment(args.get("bucket_id"))?
    );
    let mut request = ApiRequest::new("POST", path);
    request.idempotent = true;
    set_json_body(&mut request, &Value::Object(body));
    paginated(client, request, args, offset)
}

/// `offset` (from `cursor`) then `limit`, placed by `place` or added to `query`; returns the offset.
fn place_offset_pagination(
    args: &Arguments,
    query: &mut Vec<(String, String)>,
    place: &mut dyn FnMut(&str, Value),
) -> Result<f64, PluginError> {
    let offset = match args.get("cursor") {
        None => None,
        Some(cursor) => Some(parse_offset_cursor(&js::value_string(cursor))?),
    };
    for (name, value) in [
        ("offset", offset.map(number_value)),
        ("limit", args.get("limit").cloned()),
    ] {
        let Some(value) = value else { continue };
        query.push((name.to_owned(), js::value_string(&value)));
        place(name, value);
    }
    Ok(offset.unwrap_or(0.0))
}

fn parse_offset_cursor(cursor: &str) -> Result<f64, PluginError> {
    match js::parse_number(cursor) {
        Some(offset) if offset.is_finite() && offset.fract() == 0.0 && offset >= 0.0 => Ok(offset),
        _ => Err(PluginError::invalid_input(
            "`cursor` must be a next_cursor value from an earlier call (an integer >= 0)",
        )),
    }
}

/// Offset pagination: a full page (as many rows as `limit`) has a next page at offset + rows.
fn paginated(
    client: &Client,
    request: ApiRequest,
    args: &Arguments,
    offset: f64,
) -> Result<Output, PluginError> {
    let data = client.send(request)?;
    let limit = args.get("limit").and_then(Value::as_f64);
    let next_cursor = match data.as_array() {
        Some(rows) if !rows.is_empty() && limit.is_none_or(|limit| rows.len() as f64 >= limit) => {
            Some(
                client
                    .secrets()
                    .redact(&js::number_string(offset + rows.len() as f64)),
            )
        }
        _ => None,
    };
    Ok(Output {
        data: limits::truncate_for_tool(data, None),
        next_cursor,
    })
}

// --- writes ----------------------------------------------------------------------------------------

/// `toolPolicy: "optIn:SUPABASE_TOOL_ALLOW_WRITES"`.
fn assert_writes_allowed<'a>(name: &str, env: impl Fn(&str) -> &'a str) -> Result<(), PluginError> {
    if env(WRITES_ENV) == "1" {
        return Ok(());
    }
    Err(PluginError::new(
        "permission_denied",
        format!("`{name}` is disabled for agent tools; set {WRITES_ENV}=1 to allow it, or use a workflow node"),
    ))
}

fn insert_rows<'a>(
    client: &Client,
    args: &Arguments,
    env: impl Fn(&str) -> &'a str,
) -> Result<Output, PluginError> {
    assert_writes_allowed("insert_rows", env)?;
    let mut query = Vec::new();
    push_query(&mut query, "select", args.get("columns"));
    let mut request = ApiRequest::new("POST", String::new());
    place_headers(&mut request, args, &[("db_schema", "content-profile")])?;
    request
        .headers
        .insert("prefer".into(), RETURN_PREFERENCE.into());
    request.path = with_query(format!("/rest/v1/{}", segment(args.get("table"))?), &query);
    write(
        client,
        request,
        args.get("rows"),
        "select_rows with a filter on the new rows' key before inserting again",
    )
}

fn upsert_rows<'a>(
    client: &Client,
    args: &Arguments,
    env: impl Fn(&str) -> &'a str,
) -> Result<Output, PluginError> {
    let resolution = if args.get("duplicates").and_then(Value::as_str) == Some("ignore") {
        "ignore-duplicates"
    } else {
        "merge-duplicates"
    };
    assert_writes_allowed("upsert_rows", env)?;
    let mut query = Vec::new();
    push_query(&mut query, "on_conflict", args.get("on_conflict"));
    push_query(&mut query, "select", args.get("columns"));
    let mut request = ApiRequest::new("POST", String::new());
    request.headers.insert(
        "prefer".into(),
        format!("resolution={resolution},{RETURN_PREFERENCE}"),
    );
    place_headers(&mut request, args, &[("db_schema", "content-profile")])?;
    request.path = with_query(format!("/rest/v1/{}", segment(args.get("table"))?), &query);
    write(
        client,
        request,
        args.get("rows"),
        "select_rows on the conflict key",
    )
}

fn update_rows<'a>(
    client: &Client,
    args: &Arguments,
    env: impl Fn(&str) -> &'a str,
) -> Result<Output, PluginError> {
    let filters = filter_expression(args, Some("update_rows"))?;
    assert_writes_allowed("update_rows", env)?;
    let mut query = Vec::new();
    push_query(&mut query, "and", filters.map(Value::String).as_ref());
    push_query(&mut query, "select", args.get("columns"));
    let mut request = ApiRequest::new("PATCH", String::new());
    place_headers(&mut request, args, &[("db_schema", "content-profile")])?;
    request
        .headers
        .insert("prefer".into(), RETURN_PREFERENCE.into());
    request.idempotent = false;
    request.path = with_query(format!("/rest/v1/{}", segment(args.get("table"))?), &query);
    write(
        client,
        request,
        args.get("values"),
        "select_rows with the same filters",
    )
}

/// A write: never repeated, its result gets the tool size cap, unknown outcomes say how to check.
fn write(
    client: &Client,
    mut request: ApiRequest,
    body: Option<&Value>,
    check_hint: &str,
) -> Result<Output, PluginError> {
    request.idempotent = false;
    if let Some(body) = body {
        set_json_body(&mut request, body);
    }
    let data = client
        .send(request)
        .map_err(|error| with_check_hint(error, check_hint))?;
    Ok(Output::data(limits::truncate_for_tool(data, None)))
}

/// `describeWriteOutcome`: an error whose outcome is unknown says how to check, and is not retryable.
pub fn with_check_hint(mut error: PluginError, check_hint: &str) -> PluginError {
    if error.message.contains(UNKNOWN_OUTCOME_MARKER) {
        error.message = format!("{}. To check: {check_hint}", error.message);
        error.retryable = false;
    }
    error
}

fn call_function<'a>(
    client: &Client,
    args: &Arguments,
    env: impl Fn(&str) -> &'a str + Copy,
) -> Result<Output, PluginError> {
    let settings = RpcToolSettings::read_from(env)?;
    let function_name = args
        .get("function_name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    settings::assert_function_allowed(function_name, settings.allowlist.as_deref(), false)?;
    assert_writes_allowed("call_function", env)?;
    let mut request = ApiRequest::new("POST", String::new());
    place_headers(&mut request, args, &[("db_schema", "content-profile")])?;
    request.path = format!("/rest/v1/rpc/{}", segment(args.get("function_name"))?);
    request.idempotent = false;
    // The tool timeout fires before the client's own 30 s attempt timeout when it is not longer.
    request.timeout_ms = settings.timeout_ms.min(DEFAULT_TIMEOUT_MS);
    if let Some(arguments) = args.get("arguments") {
        set_json_body(&mut request, arguments);
    }
    let idempotent = request.idempotent;
    let reply = client.send_raw(request)?.map_err(|failure| {
        if failure.kind == "timeout" && settings.timeout_ms <= DEFAULT_TIMEOUT_MS {
            return PluginError::new(
                "timeout",
                format!(
                    "The database function did not answer within {} ms ({}); it may still have run, check before calling it again",
                    settings.timeout_ms,
                    settings::TIMEOUT_ENV
                ),
            );
        }
        with_check_hint(client.transport_error(&failure, idempotent), "read the rows the function changes")
    })?;
    let data = crate::response::decode(reply, client.secrets(), idempotent)
        .map_err(|error| with_check_hint(error, "read the rows the function changes"))?;
    Ok(Output::data(limits::cap_tool_rows(data, settings.max_rows)))
}

fn upload_object<'a>(
    client: &Client,
    args: &Arguments,
    env: impl Fn(&str) -> &'a str,
) -> Result<Output, PluginError> {
    if args.get("upsert") == Some(&Value::Bool(true)) {
        return Err(PluginError::new(
            "permission_denied",
            "`upload_object` as an agent tool cannot overwrite existing objects (upsert); use a workflow node",
        ));
    }
    assert_writes_allowed("upload_object", env)?;
    let mut request = ApiRequest::new("POST", String::new());
    place_headers(
        &mut request,
        args,
        &[("upsert", "x-upsert"), ("cache_control", "cache-control")],
    )?;
    request.path = format!(
        "/storage/v1/object/{}/{}",
        segment(args.get("bucket_id"))?,
        segments(args.get("object_path"))?
    );
    let file =
        upload::read_file_input(&js::value_string(args.get("file").unwrap_or(&Value::Null)))?;
    request
        .headers
        .insert("content-type".into(), file.content_type);
    request.body = Some(Body::Base64(file.base64));
    request.timeout_ms = upload::UPLOAD_TIMEOUT_MS;
    write(client, request, None, "get_object_info for the path")
}

// --- api_request -----------------------------------------------------------------------------------

fn api_request<'a>(
    client: &Client,
    args: &Arguments,
    env: impl Fn(&str) -> &'a str,
) -> Result<Output, PluginError> {
    let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
    url::assert_tool_path_allowed(path, env(url::EXTRA_PATHS_ENV))?;
    if !path.starts_with('/') {
        return Err(PluginError::invalid_input(
            "`path` must start with \"/\" and be relative to the API base URL",
        ));
    }
    let method = args
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    if method != "GET" {
        return Err(PluginError::new(
            "permission_denied",
            format!("api_request is read-only (GET) when called as an agent tool; use a dedicated operation, or a workflow node for {method}"),
        ));
    }
    if args.contains_key("body") {
        return Err(PluginError::invalid_input(
            "`body` is not allowed with GET; use `query`",
        ));
    }
    let mut request = ApiRequest::new("GET", path.to_owned());
    if let Some(Value::Object(query)) = args.get("query") {
        request.query = query
            .iter()
            .filter(|(_, value)| !value.is_null())
            .map(|(name, value)| (name.clone(), query_value(value)))
            .collect();
    }
    Ok(Output::data(client.send(request)?))
}

/// The shared client's `encodeQueryValue`: lists of scalars joined with `,`, objects as JSON.
fn query_value(value: &Value) -> String {
    match value {
        Value::Array(items)
            if items
                .iter()
                .all(|item| !item.is_object() && !item.is_array()) =>
        {
            js::value_string(value)
        }
        Value::Array(_) | Value::Object(_) => js::json_text(value),
        scalar => js::value_string(scalar),
    }
}

// --- request parts ---------------------------------------------------------------------------------

/// `filters` as PostgREST's `and` value; `required_by` names an operation that needs one.
fn filter_expression(
    args: &Arguments,
    required_by: Option<&str>,
) -> Result<Option<String>, PluginError> {
    let filters = args.get("filters").and_then(Value::as_array);
    if let Some(operation) = required_by {
        if filters.is_none_or(Vec::is_empty) {
            return Err(PluginError::invalid_input(format!(
                "`{operation}` needs at least one filter, so it never changes every row of the table"
            )));
        }
    }
    filters.map_or(Ok(None), |filters| {
        postgrest::build_filter_expression(filters)
    })
}

/// Header params, refusing line breaks and NUL characters.
fn place_headers(
    request: &mut ApiRequest,
    args: &Arguments,
    params: &[(&str, &str)],
) -> Result<(), PluginError> {
    for (param, header) in params {
        let Some(value) = args.get(*param) else {
            continue;
        };
        let text = js::value_string(value);
        if text.contains(['\r', '\n', '\0']) {
            return Err(PluginError::invalid_input(format!(
                "`{param}` must not contain line breaks or NUL characters"
            )));
        }
        request.headers.insert((*header).to_owned(), text);
    }
    Ok(())
}

fn push_query(query: &mut Vec<(String, String)>, name: &str, value: Option<&Value>) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        query.push((name.to_owned(), query_value(value)));
    }
}

fn with_query(path: String, query: &[(String, String)]) -> String {
    if query.is_empty() {
        return path;
    }
    format!("{path}?{}", js::form_urlencode(query))
}

fn set_json_body(request: &mut ApiRequest, body: &Value) {
    request
        .headers
        .insert("content-type".into(), "application/json".into());
    request.body = Some(Body::Text(body.to_string()));
}

/// `writePath` for plain keys: nested objects are created for missing segments.
fn write_path(target: &mut Map<String, Value>, path: &[&str], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut current = target;
    for parent in parents {
        let entry = current
            .entry((*parent).to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        let Value::Object(next) = entry else { return };
        current = next;
    }
    current.insert((*last).to_owned(), value);
}

/// One encoded path segment (`pathSegment`).
fn segment(value: Option<&Value>) -> Result<String, PluginError> {
    let text = value.map(js::value_string).unwrap_or_default();
    path_segment(&text, value)
}

fn path_segment(text: &str, shown: Option<&Value>) -> Result<String, PluginError> {
    if text.is_empty() || text == "." || text == ".." {
        let shown = shown.map_or_else(|| "undefined".to_owned(), js::json_text);
        return Err(PluginError::invalid_input(format!(
            "Invalid id {shown} in API path"
        )));
    }
    Ok(js::encode_uri_component(text))
}

/// `{+name}`: slash-separated segments, each encoded.
fn segments(value: Option<&Value>) -> Result<String, PluginError> {
    let text = value.map(js::value_string).unwrap_or_default();
    text.split('/')
        .map(|part| path_segment(part, Some(&Value::String(part.to_owned()))))
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}

fn number_value(number: f64) -> Value {
    json!(number as i64)
}
