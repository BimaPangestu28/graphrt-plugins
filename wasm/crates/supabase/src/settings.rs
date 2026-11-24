//! `SUPABASE_TOOL_*` settings (port of `readRpcToolSettings` and `assertFunctionAllowed`).

use graphrt_wasm_guest::PluginError;
#[cfg(feature = "user-rpc")]
use graphrt_wasm_guest::ToolCall;

#[cfg(feature = "user-rpc")]
use crate::env_of;

pub const KEY_ENV: &str = "SUPABASE_KEY";
pub const MODE_ENV: &str = "SUPABASE_TOOL_MODE";
pub const ALLOWLIST_ENV: &str = "SUPABASE_TOOL_RPC_ALLOWLIST";
pub const TIMEOUT_ENV: &str = "SUPABASE_TOOL_TIMEOUT_MS";
pub const MAX_ROWS_ENV: &str = "SUPABASE_TOOL_MAX_ROWS";
const USER_RPC_MODE: &str = "user_rpc";

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const TIMEOUT_RANGE_MS: (u64, u64) = (1_000, 120_000);
const DEFAULT_MAX_ROWS: u64 = 100;
const MAX_ROWS_RANGE: (u64, u64) = (1, 1_000);

/// Settings of one tool call.
pub struct RpcToolSettings {
    /// `None` when SUPABASE_TOOL_RPC_ALLOWLIST is unset or blank.
    pub allowlist: Option<Vec<String>>,
    pub timeout_ms: u64,
    pub max_rows: usize,
}

impl RpcToolSettings {
    /// Read and check the settings; a malformed one is named in the error.
    #[cfg(feature = "user-rpc")]
    pub fn read(call: &ToolCall) -> Result<Self, PluginError> {
        Self::read_from(|name| env_of(call, name))
    }

    /// [`RpcToolSettings::read`] from any env lookup.
    pub fn read_from<'a>(env: impl Fn(&str) -> &'a str) -> Result<Self, PluginError> {
        let allowlist = parse_allowlist(env(ALLOWLIST_ENV))?;
        let timeout_ms = read_integer(
            env(TIMEOUT_ENV),
            TIMEOUT_ENV,
            DEFAULT_TIMEOUT_MS,
            TIMEOUT_RANGE_MS,
        )?;
        let max_rows = read_integer(
            env(MAX_ROWS_ENV),
            MAX_ROWS_ENV,
            DEFAULT_MAX_ROWS,
            MAX_ROWS_RANGE,
        )?;
        Ok(Self {
            allowlist,
            timeout_ms,
            max_rows: usize::try_from(max_rows).unwrap_or(usize::MAX),
        })
    }
}

/// `SUPABASE_TOOL_MODE`: `false` for the default mode, `true` for user_rpc (`isUserRpcMode`).
fn is_user_rpc_mode(raw: &str) -> Result<bool, PluginError> {
    let mode = raw.trim().to_ascii_lowercase();
    match mode.as_str() {
        "" | "default" => Ok(false),
        USER_RPC_MODE => Ok(true),
        _ => Err(PluginError::invalid_input(format!(
            "{MODE_ENV} must be \"default\" or \"{USER_RPC_MODE}\", not \"{mode}\""
        ))),
    }
}

/// The user_rpc module serves `SUPABASE_TOOL_MODE=user_rpc` only.
#[cfg(feature = "user-rpc")]
pub fn require_user_rpc_mode(raw: &str) -> Result<(), PluginError> {
    if is_user_rpc_mode(raw)? {
        return Ok(());
    }
    Err(PluginError::invalid_input(format!(
        "This WebAssembly build serves {MODE_ENV}={USER_RPC_MODE} only; use wasm/supabase (or the Node.js supabase plugin) for the default mode"
    )))
}

/// The default module serves the default tool mode only.
#[cfg(not(feature = "user-rpc"))]
pub fn require_default_mode(raw: &str) -> Result<(), PluginError> {
    if !is_user_rpc_mode(raw)? {
        return Ok(());
    }
    Err(PluginError::invalid_input(format!(
        "This WebAssembly build serves the default tool mode; use wasm/supabase-rpc (or the Node.js supabase plugin) for {MODE_ENV}={USER_RPC_MODE}"
    )))
}

/// `SUPABASE_KEY`, trimmed; the `auth_error` names the variable when it is unset.
pub fn require_credential(key: &str) -> Result<String, PluginError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(PluginError::new(
            "auth_error",
            format!("No credential: set the {KEY_ENV} environment variable (and allow it in permissions.env)"),
        ));
    }
    Ok(key.to_owned())
}

/// Comma list of plain function names, de-duplicated in order.
pub fn parse_allowlist(raw: &str) -> Result<Option<Vec<String>>, PluginError> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let mut names: Vec<String> = Vec::new();
    for name in raw
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        if !names.iter().any(|seen| seen == name) {
            names.push(name.to_owned());
        }
    }
    if let Some(bad) = names.iter().find(|name| !is_function_name(name)) {
        return Err(config_error(format!(
            "{ALLOWLIST_ENV} has \"{bad}\", which is not a plain function name"
        )));
    }
    Ok(Some(names))
}

/// `^[A-Za-z_][A-Za-z0-9_]{0,62}$`
fn is_function_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    let first_ok = bytes
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_');
    first_ok
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

// Whole numbers like JavaScript's Number() reads them in practice: digits, optionally with a `.000` fraction.
fn read_integer(
    raw: &str,
    name: &str,
    default: u64,
    (minimum, maximum): (u64, u64),
) -> Result<u64, PluginError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(default);
    }
    let (whole, fraction) = raw.split_once('.').unwrap_or((raw, "0"));
    let is_whole = !fraction.is_empty() && fraction.bytes().all(|b| b == b'0');
    let value = whole
        .parse::<u64>()
        .ok()
        .filter(|v| is_whole && (minimum..=maximum).contains(v));
    match value {
        Some(value) => Ok(value),
        None => Err(config_error(format!(
            "{name} must be a whole number from {minimum} to {maximum}, not \"{raw}\""
        ))),
    }
}

fn config_error(message: String) -> PluginError {
    PluginError::invalid_input(format!("Plugin configuration: {message}"))
}

/// Refuse a function the allowlist does not name (model-written names are untrusted). Without an
/// allowlist every function is refused when `list_required` (user_rpc), and allowed otherwise.
pub fn assert_function_allowed(
    name: &str,
    allowlist: Option<&[String]>,
    list_required: bool,
) -> Result<(), PluginError> {
    let Some(allowlist) = allowlist else {
        if !list_required {
            return Ok(());
        }
        return Err(PluginError::new(
            "permission_denied",
            format!("No database function may be called: set {ALLOWLIST_ENV} to the functions this agent may use"),
        ));
    };
    if allowlist.iter().any(|allowed| allowed == name) {
        return Ok(());
    }
    let shown = crate::limits::utf16_prefix(name, 80);
    Err(PluginError::new(
        "permission_denied",
        format!(
            "Function \"{shown}\" is not allowed for this agent. Allowed functions: {}",
            allowlist.join(", ")
        ),
    ))
}
