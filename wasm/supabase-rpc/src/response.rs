//! PostgREST responses and credential redaction (port of the shared API client's
//! `readBody`, `buildHttpError` and `redact`, with the plugin's `errors` spec).

use graphrt_wasm_guest::{serde_json, HttpResponse, PluginError, Value};

const REDACTED: &str = "[redacted]";
const UNKNOWN_OUTCOME_NOTE: &str =
    " (outcome unknown: the write may have been applied; check before retrying)";

/// Credentials of one call, redacted from every result and error.
pub struct Secrets {
    user_jwt: String,
    publishable_key: String,
    /// Longest first, so `Bearer <jwt>` goes before `<jwt>`.
    values: Vec<String>,
}

impl Secrets {
    pub fn new(user_jwt: String, publishable_key: String) -> Self {
        let mut values = Vec::new();
        for value in [
            format!("Bearer {user_jwt}"),
            user_jwt.clone(),
            publishable_key.clone(),
        ] {
            if value.chars().count() >= 4 && !values.contains(&value) {
                values.push(value);
            }
        }
        Self {
            user_jwt,
            publishable_key,
            values,
        }
    }

    pub fn user_jwt(&self) -> &str {
        &self.user_jwt
    }

    pub fn publishable_key(&self) -> &str {
        &self.publishable_key
    }

    pub fn redact(&self, text: &str) -> String {
        self.values.iter().fold(text.to_owned(), |text, secret| {
            text.replace(secret.as_str(), REDACTED)
        })
    }

    /// Redact every string in `value` (object keys stay).
    fn redact_deep(&self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.redact(&text)),
            Value::Array(items) => Value::Array(
                items
                    .into_iter()
                    .map(|item| self.redact_deep(item))
                    .collect(),
            ),
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, item)| (key, self.redact_deep(item)))
                    .collect(),
            ),
            other => other,
        }
    }
}

/// The function's result, or the API error the response describes.
pub fn decode(response: HttpResponse, secrets: &Secrets) -> Result<Value, PluginError> {
    let body = parse_body(&response.body);
    if (200..300).contains(&response.status) {
        return Ok(secrets.redact_deep(body));
    }
    Err(api_error(response.status, &body, secrets))
}

/// An empty body is `{}`, text that is not JSON is `{text}`.
fn parse_body(text: &str) -> Value {
    if text.is_empty() {
        return Value::Object(Default::default());
    }
    serde_json::from_str(text).unwrap_or_else(|_| graphrt_wasm_guest::json!({ "text": text }))
}

fn api_error(status: u16, body: &Value, secrets: &Secrets) -> PluginError {
    let code = body.get("code").filter(|code| !code.is_null());
    let message = ["message", "msg", "error_description"]
        .iter()
        .find_map(|key| {
            body.get(*key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        });
    let kind = code
        .and_then(kind_for_code)
        .unwrap_or_else(|| kind_for_status(status));
    let api_message = match (message, code) {
        (Some(message), Some(code)) => format!("{message} ({})", code_text(code)),
        (Some(message), None) => message.to_owned(),
        (None, _) => generic_message(body).unwrap_or_else(|| reason_phrase(status).to_owned()),
    };
    let server_failure = kind == "api_error" && status >= 500;
    let note = if server_failure {
        UNKNOWN_OUTCOME_NOTE
    } else {
        ""
    };
    let mut error = PluginError::new(
        kind,
        secrets.redact(&format!("API error {status}: {api_message}{note}")),
    );
    error.retryable = kind == "rate_limited";
    error
}

fn code_text(code: &Value) -> String {
    code.as_str()
        .map_or_else(|| code.to_string(), str::to_owned)
}

/// The plugin's `errors.kindByCode`.
fn kind_for_code(code: &Value) -> Option<&'static str> {
    Some(match code_text(code).as_str() {
        "PGRST301" | "PGRST302" | "PGRST303" | "InvalidJWT" => "auth_error",
        "42501" => "permission_denied",
        "PGRST202" | "PGRST205" | "NoSuchBucket" | "NoSuchKey" => "not_found",
        _ => return None,
    })
}

fn kind_for_status(status: u16) -> &'static str {
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
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    };
    let error = body.get("error");
    text(error.and_then(|e| e.get("message")))
        .or_else(|| text(body.get("error_description")))
        .or_else(|| text(error))
        .or_else(|| text(body.get("detail")))
        .or_else(|| text(body.get("message")))
        .or_else(|| text(body.get("title")))
        .or_else(|| {
            text(
                body.get("errors")
                    .and_then(|e| e.get(0))
                    .and_then(|e| e.get("message")),
            )
        })
        .or_else(|| text(body.get("text")))
}

/// `statusText` of the common statuses (the host does not pass the reason phrase).
fn reason_phrase(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "",
    }
}
