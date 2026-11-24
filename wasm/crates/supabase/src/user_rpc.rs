//! Per-user RPC tool (port of `supabase/lib/rpc-tool.mjs`, `SUPABASE_TOOL_MODE=user_rpc`):
//! one tool, `call_function`, that calls an allowed Postgres function
//! (`POST {SUPABASE_URL}/rest/v1/rpc/{name}`) as the signed-in end user:
//! `apikey` is `SUPABASE_KEY` (publishable / anon only) and
//! `Authorization: Bearer <user_jwt>` comes from the agent's per-call
//! `tool_context`, never from env or the model.

use graphrt_wasm_guest::{http, json, HttpRequest, PluginError, ToolCall, Value};

use crate::settings::{self, require_credential, RpcToolSettings, KEY_ENV, TIMEOUT_ENV};
use crate::{env_of, jwt, limits, project_url, response};

pub const TOOL_NAME: &str = "call_function";
const USER_JWT_SECRET: &str = "user_jwt";
const SECRET_KEY_PREFIX: &str = "sb_secret_";

pub const TOOL_DESCRIPTION: &str =
    "Call an allowed Postgres function (RPC) as the signed-in end user; row level security \
applies, so results only include what this user may see";

pub fn tool_parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "function_name": {"type": "string", "description": "Function name"},
            "arguments": {"type": "object", "description": "Named arguments, e.g. {\"order_id\": 7}"},
        },
        "required": ["function_name"],
    })
}

/// The end user's token and the publishable key sent with it.
struct UserCredentials {
    user_jwt: String,
    publishable_key: String,
}

/// Validated tool arguments.
struct RpcArguments {
    function_name: String,
    arguments: Value,
}

/// The whole tool call, in the order of the Node.js plugin's checks: mode, arguments,
/// credential, project URL, settings, allowlist, user JWT, key, request.
pub fn call_function_as_user(call: &ToolCall) -> Result<Value, PluginError> {
    let env = |name: &str| env_of(call, name);
    settings::require_user_rpc_mode(env(settings::MODE_ENV))?;
    let allowlist_enum = settings::parse_allowlist(env(settings::ALLOWLIST_ENV))
        .ok()
        .flatten();
    let args = validate_arguments(&call.arguments, allowlist_enum.as_deref())?;
    let configured_key = require_credential(env(KEY_ENV))?;
    let base_url = project_url::resolve(env(project_url::URL_ENV))?;
    let settings = RpcToolSettings::read(call)?;
    settings::assert_function_allowed(&args.function_name, settings.allowlist.as_deref(), true)?;
    let user_jwt = jwt::read_user_jwt(call.secret(USER_JWT_SECRET))?;
    let publishable_key = read_publishable_key(&configured_key)?;
    let secrets = response::Secrets::from_values([
        format!("Bearer {user_jwt}"),
        user_jwt.clone(),
        publishable_key.clone(),
    ]);
    let credentials = UserCredentials {
        user_jwt,
        publishable_key,
    };
    let url = format!("{base_url}/rest/v1/rpc/{}", args.function_name);
    let body = send_rpc(
        &url,
        &args.arguments,
        (&credentials, &secrets),
        settings.timeout_ms,
    )?;
    Ok(limits::cap_tool_rows(body, settings.max_rows))
}

/// `validateArguments` of the shared runner for the tool's schema.
fn validate_arguments(
    raw: &Value,
    allowlist: Option<&[String]>,
) -> Result<RpcArguments, PluginError> {
    let function_name = match raw.get("function_name") {
        None | Some(Value::Null) => return Err(invalid_argument("function_name", "is required")),
        Some(Value::String(name)) if name.is_empty() => {
            return Err(invalid_argument("function_name", "is required"))
        }
        Some(Value::String(name)) => name.clone(),
        Some(Value::Number(number)) => number_as_string(number)?,
        Some(_) => return Err(invalid_argument("function_name", "must be of type string")),
    };
    let function_name = match allowlist.filter(|names| !names.is_empty()) {
        Some(names) => canonical_enum(names, function_name)?,
        None => function_name,
    };
    let arguments = match raw.get("arguments") {
        None | Some(Value::Null) => Value::Object(Default::default()),
        Some(Value::String(text)) if text.is_empty() => Value::Object(Default::default()),
        Some(Value::String(text)) => object_from_text(text)?,
        Some(Value::Object(object)) => Value::Object(object.clone()),
        Some(_) => return Err(invalid_argument("arguments", "must be of type object")),
    };
    Ok(RpcArguments {
        function_name,
        arguments,
    })
}

// Models sometimes send an object argument as JSON text.
fn object_from_text(text: &str) -> Result<Value, PluginError> {
    let trimmed = text.trim();
    match trimmed
        .starts_with('{')
        .then(|| graphrt_wasm_guest::serde_json::from_str::<Value>(trimmed))
    {
        Some(Ok(value @ Value::Object(_))) => Ok(value),
        _ => Err(invalid_argument("arguments", "must be of type object")),
    }
}

// IDs arrive as numbers from LLM tool calls; JavaScript keeps safe integers exact.
fn number_as_string(
    number: &graphrt_wasm_guest::serde_json::Number,
) -> Result<String, PluginError> {
    const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
    let too_large = number.as_u64().is_some_and(|n| n > MAX_SAFE_INTEGER)
        || number
            .as_i64()
            .is_some_and(|n| n.unsigned_abs() > MAX_SAFE_INTEGER);
    if too_large {
        return Err(PluginError::invalid_input(format!(
            "Number {number} is too large to be exact; quote it as a string"
        )));
    }
    Ok(graphrt_wasm_guest::serde_json::to_string(number).unwrap_or_default())
}

/// Accept a unique case-insensitive match, then require one of `names` (the parameter's `enum`).
fn canonical_enum(names: &[String], value: String) -> Result<String, PluginError> {
    if names.contains(&value) {
        return Ok(value);
    }
    // Allowlisted names are ASCII (`^[A-Za-z_][A-Za-z0-9_]*$`), so an ASCII comparison is the Unicode one.
    let matches: Vec<&String> = names
        .iter()
        .filter(|name| name.eq_ignore_ascii_case(&value))
        .collect();
    if let [only] = matches.as_slice() {
        return Ok((*only).clone());
    }
    Err(invalid_argument(
        "function_name",
        &format!("must be one of {}", names.join(", ")),
    ))
}

fn invalid_argument(name: &str, problem: &str) -> PluginError {
    PluginError::invalid_input(format!("`{name}` {problem}"))
}

/// user_rpc never sends a key that bypasses row level security, not even as `apikey`.
fn read_publishable_key(key: &str) -> Result<String, PluginError> {
    let service_role = jwt::payload_of(key)
        .is_some_and(|payload| jwt::role_of(payload).as_deref() == Some("service_role"));
    if key.starts_with(SECRET_KEY_PREFIX) || service_role {
        return Err(PluginError::new(
            "auth_error",
            "SUPABASE_TOOL_MODE=user_rpc needs SUPABASE_KEY to be the publishable (sb_publishable_...) or anon key, not a secret or service_role key",
        ));
    }
    Ok(key.to_owned())
}

/// POST the RPC through the host and turn the answer into the function's result.
fn send_rpc(
    url: &str,
    arguments: &Value,
    (credentials, secrets): (&UserCredentials, &response::Secrets),
    timeout_ms: u64,
) -> Result<Value, PluginError> {
    let mut request = HttpRequest {
        method: "POST".into(),
        url: url.into(),
        body: Some(arguments.to_string()),
        timeout_ms: Some(timeout_ms),
        ..HttpRequest::default()
    };
    request
        .headers
        .insert("accept".into(), "application/json".into());
    request
        .headers
        .insert("content-type".into(), "application/json".into());
    request
        .headers
        .insert("apikey".into(), credentials.publishable_key.clone());
    request.headers.insert(
        "authorization".into(),
        format!("Bearer {}", credentials.user_jwt),
    );
    let reply = http(&request)
        .map_err(|error| transport_error(&error.kind, &error.message, secrets, timeout_ms))?;
    response::decode(reply, secrets, false)
}

fn transport_error(
    kind: &str,
    message: &str,
    secrets: &response::Secrets,
    timeout_ms: u64,
) -> PluginError {
    if kind == "timeout" {
        return PluginError::new(
            "timeout",
            format!(
                "The database function did not answer within {timeout_ms} ms ({TIMEOUT_ENV}); it may still have run, check before calling it again"
            ),
        );
    }
    PluginError::new(
        "network_error",
        secrets.redact(&format!(
            "Network error: {message}{}",
            response::UNKNOWN_OUTCOME_NOTE
        )),
    )
}
