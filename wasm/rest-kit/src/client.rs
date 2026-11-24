//! The HTTP client of one API (port of `api-client.mjs` as the declarative layer configures it): URL building that
//! keeps every request on the API's origin, credentials, retries where they are safe, error mapping and redaction
//! of the request's secrets from results and messages.
//!
//! WebAssembly has no clock, so retries are sent at once instead of after the Node.js plugin's backoff, and a
//! rate-limited call (429 or a `rate_limited` body error) is returned at once with `retryable: true`.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::error::RestError;
use crate::js;
use crate::path::read_path;
use crate::url::{encode_uri_component, Url};

/// Sends one HTTP request; graphrt's `graphrt::http` in WebAssembly, a fake in tests.
pub trait Transport {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, HttpError>;
}

/// An outbound request, as `graphrt::http` takes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    /// Lower-case names.
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    /// Deadline in ms; the host caps it (30 s by default).
    pub timeout_ms: Option<u64>,
}

/// A response from `graphrt::http` (any status: redirects are not followed).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HttpResponse {
    pub status: u16,
    /// Lower-case names.
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

/// Why `graphrt::http` failed: `invalid_request`, `egress_denied`, `timeout`, `too_large` or `http_error`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HttpError {
    pub kind: String,
    pub message: String,
}

/// The host's `graphrt::http` (SSRF-safe egress, no redirects), called directly: no serde derive code in the module.
pub struct HostTransport;

impl Transport for HostTransport {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, HttpError> {
        let mut payload = json!({"method": request.method, "url": request.url, "headers": request.headers});
        if let Some(body) = &request.body {
            payload["body"] = Value::String(body.clone());
        }
        if let Some(timeout_ms) = request.timeout_ms {
            payload["timeout_ms"] = Value::from(timeout_ms);
        }
        let reply: Value = serde_json::from_slice(&host_http(js::stringify(&payload).as_bytes()))
            .map_err(|_| HttpError { kind: "http_error".into(), message: "the host's reply is not JSON".into() })?;
        if let Some(error) = reply.get("error") {
            let text = |field: &str| error.get(field).and_then(Value::as_str).unwrap_or_default().to_owned();
            return Err(HttpError { kind: text("kind"), message: text("message") });
        }
        let headers = reply.get("headers").and_then(Value::as_object).into_iter().flatten();
        Ok(HttpResponse {
            status: reply.get("status").and_then(Value::as_u64).unwrap_or(0) as u16,
            headers: headers
                .filter_map(|(name, value)| Some((name.to_ascii_lowercase(), value.as_str()?.to_owned())))
                .collect(),
            body: reply.get("body").and_then(Value::as_str).unwrap_or_default().to_owned(),
        })
    }
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "graphrt")]
extern "C" {
    #[link_name = "http"]
    fn graphrt_http(ptr: i32, len: i32) -> i64;
}

#[cfg(target_arch = "wasm32")]
fn host_http(payload: &[u8]) -> Vec<u8> {
    // SAFETY: the host reads `payload` and returns a buffer it wrote through `graphrt_alloc`, never freed.
    unsafe {
        let packed = graphrt_http(payload.as_ptr() as usize as i32, payload.len() as i32) as u64;
        std::slice::from_raw_parts((packed >> 32) as usize as *const u8, (packed & 0xffff_ffff) as usize).to_vec()
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn host_http(_payload: &[u8]) -> Vec<u8> {
    br#"{"error":{"kind":"egress_denied","message":"no graphrt host outside WebAssembly"}}"#.to_vec()
}

pub const UNKNOWN_OUTCOME_NOTE: &str = " (outcome unknown: the write may have been applied; check before retrying)";
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const DEFAULT_MAX_RETRIES: u64 = 2;
const MAX_RETRY_WAIT_MS: f64 = 60_000.0;
const REDACTED: &str = "[redacted]";

/// A client bound to one base URL of an API, with its credential (if it sends one).
#[derive(Clone)]
pub struct Client<'a> {
    pub api: &'a Value,
    /// The API's name in the spec (`apis`).
    pub api_name: String,
    pub base_url: String,
    pub credential: Option<String>,
}

/// One request: what `client.requestWithHeaders(options)` gets.
#[derive(Default)]
pub struct RequestOptions {
    pub method: String,
    pub path: String,
    /// `query` option (api_request's), set on the URL with `searchParams.set`.
    pub query: Map<String, Value>,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    /// `json` option: encoded with `JSON.stringify` and sent as application/json.
    pub json: Option<Value>,
    /// `true`/`false` overrides the method's idempotency (GET, HEAD, PUT, DELETE).
    pub idempotent: Option<bool>,
    pub timeout_ms: Option<u64>,
}

/// A successful response.
pub struct Response {
    pub body: Value,
    pub headers: BTreeMap<String, String>,
    pub secrets: Vec<String>,
}

impl Response {
    /// `redact(value)`: this request's secrets replaced in every string.
    pub fn redact(&self, value: Value) -> Value {
        redact_value(value, &self.secrets)
    }
}

struct Prepared {
    request: HttpRequest,
    secrets: Vec<String>,
    is_idempotent: bool,
}

impl<'a> Client<'a> {
    /// `requestWithHeaders(options)` with `redactResponse: true`.
    pub fn send(&self, options: RequestOptions, transport: &dyn Transport) -> Result<Response, RestError> {
        let prepared = self.prepare(options)?;
        let max_retries = self.api.get("maxRetries").and_then(Value::as_u64).unwrap_or(DEFAULT_MAX_RETRIES);
        let mut attempt = 0;
        loop {
            match self.send_once(&prepared, transport) {
                Ok(response) => {
                    let body = redact_value(response.body, &prepared.secrets);
                    return Ok(Response { body, ..response });
                }
                Err(error) if should_retry_now(&error, attempt, max_retries) => attempt += 1,
                Err(error) => return Err(error),
            }
        }
    }

    fn prepare(&self, options: RequestOptions) -> Result<Prepared, RestError> {
        let method = options.method.to_ascii_uppercase();
        let has_body = options.json.is_some() || options.body.is_some();
        if has_body && (method == "GET" || method == "HEAD") {
            return Err(RestError::invalid_input(format!(
                "A {method} request cannot have a body; use query parameters instead"
            )));
        }
        let is_idempotent = options.idempotent.unwrap_or(matches!(method.as_str(), "GET" | "HEAD" | "PUT" | "DELETE"));
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        headers.insert("accept".into(), "application/json".into());
        if let Some(default_headers) = self.api.get("defaultHeaders").and_then(Value::as_object) {
            for (name, value) in default_headers {
                headers.insert(name.to_ascii_lowercase(), js::to_text(value));
            }
        }
        for (name, value) in options.headers {
            headers.insert(name.to_ascii_lowercase(), value);
        }
        let mut query = options.query;
        let credential_secrets = self.authorize(&mut headers, &mut query);
        let url = build_url(&self.base_url, &options.path, &query)?;
        let body = match options.json {
            Some(json_body) => {
                headers.insert("content-type".into(), "application/json".into());
                Some(js::stringify(&json_body))
            }
            None => options.body,
        };
        let secrets = collect_secrets(&headers, &query, credential_secrets);
        let timeout_ms = options
            .timeout_ms
            .or_else(|| self.api.get("timeoutMs").and_then(Value::as_u64))
            .unwrap_or(DEFAULT_TIMEOUT_MS);
        let request = HttpRequest { method, url, headers, body, timeout_ms: Some(timeout_ms) };
        Ok(Prepared { request, secrets, is_idempotent })
    }

    // The auth's `authorize` hook: sets the credential, returns the secrets to redact.
    fn authorize(&self, headers: &mut BTreeMap<String, String>, query: &mut Map<String, Value>) -> Vec<String> {
        let Some(credential) = &self.credential else { return Vec::new() };
        let auth = &self.api["auth"];
        match auth["type"].as_str().unwrap_or("none") {
            "bearer" => {
                headers.insert("authorization".into(), format!("Bearer {credential}"));
            }
            "header" => {
                let header = auth["header"].as_str().unwrap_or_default().to_ascii_lowercase();
                headers.insert(header, format!("{}{credential}", auth["prefix"].as_str().unwrap_or_default()));
            }
            "query" => {
                query.insert(auth["param"].as_str().unwrap_or_default().into(), Value::String(credential.clone()));
            }
            _ => return Vec::new(),
        }
        vec![credential.clone(), encode_uri_component(credential)]
    }

    fn send_once(&self, prepared: &Prepared, transport: &dyn Transport) -> Result<Response, RestError> {
        let reply = transport.send(&prepared.request).map_err(|error| transport_error(&error, prepared))?;
        let body = read_body(&reply.body);
        if (200..300).contains(&reply.status) {
            if let Some(body_error) = detect_body_error(&self.api["errors"], &body) {
                return Err(build_body_error(body_error, &prepared.secrets));
            }
            return Ok(Response { body, headers: reply.headers, secrets: prepared.secrets.clone() });
        }
        Err(build_http_error(&self.api["errors"], &reply, &body, prepared))
    }
}

// Node.js waits (Retry-After or 1 s, 2 s) and retries; without a clock, retrying a rate limit at once is pointless.
fn should_retry_now(error: &RestError, attempt: u64, max_retries: u64) -> bool {
    let waits_too_long = error.retry_after_ms.is_some_and(|wait| wait > MAX_RETRY_WAIT_MS);
    error.retryable && attempt < max_retries && error.kind != "rate_limited" && !waits_too_long
}

/// `buildUrl(baseUrl, path, query)`: relative paths are joined to the base path; nothing may leave its origin.
pub fn build_url(base_url: &str, path: &str, query: &Map<String, Value>) -> Result<String, RestError> {
    let base =
        Url::parse(base_url).ok_or_else(|| RestError::invalid_input(format!("Invalid API base URL {base_url}")))?;
    let is_absolute = path.len() >= 7
        && (path[..7].eq_ignore_ascii_case("http://")
            || path.get(..8).is_some_and(|start| start.eq_ignore_ascii_case("https://")));
    let mut url = if is_absolute {
        let url = Url::parse(path)
            .ok_or_else(|| RestError::invalid_input(format!("Invalid URL {}", js::json_string(path))))?;
        if url.origin() != base.origin() {
            return Err(RestError::invalid_input(format!(
                "Refusing to call {}: only {} is allowed",
                url.origin(),
                base.origin()
            )));
        }
        url
    } else {
        if !is_safe_path(path) {
            return Err(RestError::invalid_input(format!(
                "Unsafe API path {}: use \"/segment/...\" without \"//\", \"\\\" or dot segments",
                js::json_string(path)
            )));
        }
        base.with_path(&format!("{}{path}", base.path.strip_suffix('/').unwrap_or(&base.path)))
    };
    for (name, value) in query {
        if !value.is_null() {
            url.set_search_param(name, &encode_query_value(value));
        }
    }
    Ok(url.href())
}

fn is_safe_path(path: &str) -> bool {
    path.starts_with('/') && !path.starts_with("//") && !path.contains('\\') && !has_dot_segment(path)
}

const MAX_DECODE_ROUNDS: usize = 4;

// "%2e%2e" is ".." to the URL parser and some servers decode twice: decode each segment until it is stable.
fn has_dot_segment(path: &str) -> bool {
    let pathname = path.split(['?', '#']).next().unwrap_or_default();
    pathname.split('/').any(|segment| {
        let mut decoded = segment.to_owned();
        for _ in 0..MAX_DECODE_ROUNDS {
            if decoded.split('\\').any(|part| part == "." || part == "..") {
                return true;
            }
            match crate::url::decode_uri_component(&decoded) {
                Some(next) if next != decoded => decoded = next,
                _ => return false,
            }
        }
        true
    })
}

/// `encodeQueryValue`: lists of primitives joined with commas, objects as JSON, the rest as `String(value)`.
pub fn encode_query_value(value: &Value) -> String {
    match value {
        Value::Array(items) if items.iter().all(|item| !item.is_object() && !item.is_array()) => js::to_text(value),
        Value::Array(_) | Value::Object(_) => js::stringify(value),
        other => js::to_text(other),
    }
}

fn collect_secrets(
    headers: &BTreeMap<String, String>,
    query: &Map<String, Value>,
    credential_secrets: Vec<String>,
) -> Vec<String> {
    let mut values: Vec<String> = Vec::new();
    if let Some(authorization) = headers.get("authorization").filter(|value| !value.is_empty()) {
        values.push(authorization.clone());
    }
    for name in ["access_token", "key"] {
        if let Some(value) = query.get(name).filter(|value| js::is_truthy(Some(value))) {
            values.push(js::to_text(value));
        }
    }
    values.extend(credential_secrets.into_iter().filter(|secret| !secret.is_empty()));
    let stripped: Vec<String> = values.iter().map(|value| strip_scheme(value).to_owned()).collect();
    let mut secrets: Vec<String> = Vec::new();
    for secret in values.into_iter().chain(stripped) {
        if js::utf16_len(&secret) >= 4 && !secrets.contains(&secret) {
            secrets.push(secret);
        }
    }
    secrets
}

// `value.replace(/^(Bearer|Basic)\s+/i, "")`.
fn strip_scheme(value: &str) -> &str {
    for scheme in ["bearer", "basic"] {
        if value.len() > scheme.len() && value[..scheme.len()].eq_ignore_ascii_case(scheme) {
            let rest = &value[scheme.len()..];
            let trimmed =
                rest.trim_start_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
            if trimmed.len() < rest.len() {
                return trimmed;
            }
        }
    }
    value
}

/// Every secret replaced with `[redacted]` in `text`.
pub fn redact_text(text: &str, secrets: &[String]) -> String {
    secrets.iter().fold(text.to_owned(), |redacted, secret| {
        if redacted.contains(secret.as_str()) {
            redacted.replace(secret.as_str(), REDACTED)
        } else {
            redacted
        }
    })
}

/// `redactDeep`: string values (not keys) redacted everywhere.
pub fn redact_value(value: Value, secrets: &[String]) -> Value {
    if secrets.is_empty() {
        return value;
    }
    match value {
        Value::String(text) => Value::String(redact_text(&text, secrets)),
        Value::Array(items) => Value::Array(items.into_iter().map(|item| redact_value(item, secrets)).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(key, item)| (key, redact_value(item, secrets))).collect())
        }
        other => other,
    }
}

fn read_body(text: &str) -> Value {
    if text.is_empty() {
        return json!({});
    }
    serde_json::from_str(text).unwrap_or_else(|_| json!({ "text": text }))
}

fn transport_error(error: &HttpError, prepared: &Prepared) -> RestError {
    let reason = if error.kind == "timeout" { "request timed out" } else { error.message.as_str() };
    let note = if prepared.is_idempotent { "" } else { UNKNOWN_OUTCOME_NOTE };
    RestError::new("network_error", redact_text(&format!("Network error: {reason}{note}"), &prepared.secrets))
        .with_retryable(prepared.is_idempotent)
}

/// What the `errors` spec reads from an error body (`describeBodyError`).
#[derive(Default)]
struct BodyError {
    message: Option<String>,
    kind: Option<String>,
    retryable: Option<bool>,
    retry_after_ms: Option<f64>,
}

fn describe_body_error(errors: &Value, body: &Value) -> BodyError {
    let mut parsed = BodyError::default();
    if !(body.is_object() || body.is_array()) {
        return parsed;
    }
    let code = errors.get("codePath").and_then(Value::as_str).and_then(|code_path| read_path(body, Some(code_path)));
    if let Some(message) = find_message(errors, body) {
        parsed.message = Some(match code {
            None | Some(Value::Null) => message,
            Some(code) => format!("{message} ({})", js::to_text(code)),
        });
    }
    if let Some(code) = code {
        let code_text = js::to_text(code);
        parsed.kind = errors
            .get("kindByCode")
            .and_then(|kinds| kinds.get(&code_text))
            .and_then(Value::as_str)
            .filter(|kind| !kind.is_empty())
            .map(str::to_owned);
        let retryable_codes = errors.get("retryableCodes").and_then(Value::as_array);
        if retryable_codes.is_some_and(|codes| codes.iter().any(|retryable| js::to_text(retryable) == code_text)) {
            parsed.retryable = Some(true);
        }
    }
    parsed.retry_after_ms = read_retry_after_ms(errors, body);
    parsed
}

fn find_message(errors: &Value, body: &Value) -> Option<String> {
    let paths: Vec<&str> = match errors.get("messagePath") {
        Some(Value::String(path)) => vec![path.as_str()],
        Some(Value::Array(paths)) => paths.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    paths.into_iter().find_map(|path| {
        read_path(body, Some(path)).and_then(Value::as_str).filter(|message| !message.is_empty()).map(str::to_owned)
    })
}

fn read_retry_after_ms(errors: &Value, body: &Value) -> Option<f64> {
    let path = errors.get("retryAfterPath").and_then(Value::as_str).filter(|path| !path.is_empty())?;
    let retry_after = read_path(body, Some(path)).map_or(f64::NAN, js::to_number);
    if !retry_after.is_finite() || retry_after < 0.0 {
        return None;
    }
    Some(if errors.get("retryAfterUnit").and_then(Value::as_str) == Some("milliseconds") {
        retry_after
    } else {
        retry_after * 1000.0
    })
}

// `detectBodyError`: error-in-2xx through okPath/okValue or errorPath.
fn detect_body_error(errors: &Value, body: &Value) -> Option<BodyError> {
    let ok_path = errors.get("okPath").and_then(Value::as_str);
    let error_path = errors.get("errorPath").and_then(Value::as_str);
    if (ok_path.is_none() && error_path.is_none()) || !(body.is_object() || body.is_array()) {
        return None;
    }
    let ok_value = errors.get("okValue").cloned().unwrap_or(Value::Bool(true));
    let ok_failed = ok_path.and_then(|path| read_path(body, Some(path))).is_some_and(|value| *value != ok_value);
    let error_present = error_path.is_some_and(|path| js::is_truthy(read_path(body, Some(path))));
    if !ok_failed && !error_present {
        return None;
    }
    let mut body_error = describe_body_error(errors, body);
    if body_error.message.is_none() {
        body_error.message = Some(fallback_message(error_path, body));
    }
    body_error.kind.get_or_insert_with(|| "api_error".into());
    Some(body_error)
}

fn fallback_message(error_path: Option<&str>, body: &Value) -> String {
    match error_path.and_then(|path| read_path(body, Some(path))) {
        Some(Value::String(text)) => text.clone(),
        Some(value @ (Value::Object(_) | Value::Array(_))) => js::utf16_prefix(&js::stringify(value), 500).to_owned(),
        Some(value) if js::is_truthy(Some(value)) => "the API reported an error in a successful response".into(),
        _ => "the API reported an error in a successful response".into(),
    }
}

fn build_body_error(body_error: BodyError, secrets: &[String]) -> RestError {
    let kind = body_error.kind.unwrap_or_else(|| "api_error".into());
    let retryable = body_error.retryable.unwrap_or(kind == "rate_limited");
    let message = redact_text(&format!("API error: {}", body_error.message.unwrap_or_default()), secrets);
    RestError { kind, message, retryable, retry_after_ms: body_error.retry_after_ms }
}

fn build_http_error(errors: &Value, reply: &HttpResponse, body: &Value, prepared: &Prepared) -> RestError {
    let status = reply.status;
    let parsed = describe_body_error(errors, body);
    let status_kind = errors
        .get("kindByStatus")
        .and_then(|kinds| kinds.get(status.to_string()))
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty());
    let kind = parsed
        .kind
        .clone()
        .or_else(|| status_kind.map(str::to_owned))
        .unwrap_or_else(|| default_kind_for_status(status).into());
    let api_message =
        parsed.message.clone().or_else(|| generic_message(body)).unwrap_or_else(|| reason_phrase(status).into());
    let retry_after_ms =
        parsed.retry_after_ms.or_else(|| reply.headers.get("retry-after").and_then(|header| parse_retry_after(header)));
    let is_server_failure = kind == "api_error" && status >= 500;
    let retryable = parsed.retryable.unwrap_or(kind == "rate_limited" || (is_server_failure && prepared.is_idempotent));
    let note = if is_server_failure && !prepared.is_idempotent { UNKNOWN_OUTCOME_NOTE } else { "" };
    let message = redact_text(&format!("API error {status}: {api_message}{note}"), &prepared.secrets);
    RestError { kind, message, retryable, retry_after_ms }
}

fn default_kind_for_status(status: u16) -> &'static str {
    match status {
        400 | 422 => "invalid_input",
        401 => "auth_error",
        403 => "permission_denied",
        404 => "not_found",
        429 => "rate_limited",
        _ => "api_error",
    }
}

fn generic_message(body: &Value) -> Option<String> {
    let error = body.get("error");
    let candidates = [
        error.and_then(|error| error.get("message")),
        body.get("error_description"),
        error.filter(|error| error.is_string()),
        body.get("detail"),
        body.get("message"),
        body.get("title"),
        body.get("errors").and_then(|errors| errors.get(0)).and_then(|first| first.get("message")),
        body.get("text"),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(|candidate| candidate.as_str().filter(|text| !text.is_empty()).map(str::to_owned))
}

// Seconds only: an HTTP date needs a clock.
fn parse_retry_after(header: &str) -> Option<f64> {
    let seconds = js::parse_number(header);
    seconds.is_finite().then(|| (seconds * 1000.0).max(0.0))
}

/// The standard reason phrase, which Node.js shows as `statusText` (graphrt's HTTP replies carry no phrase).
pub fn reason_phrase(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}
