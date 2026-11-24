//! `SUPABASE_TOOL_*` settings (port of `readRpcToolSettings` and `assertFunctionAllowed`).

use graphrt_wasm_guest::{PluginError, ToolCall};

use crate::env_of;

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
    pub fn read(call: &ToolCall) -> Result<Self, PluginError> {
        let allowlist = parse_allowlist(env_of(call, ALLOWLIST_ENV))?;
        let timeout_ms = read_integer(
            env_of(call, TIMEOUT_ENV),
            TIMEOUT_ENV,
            DEFAULT_TIMEOUT_MS,
            TIMEOUT_RANGE_MS,
        )?;
        let max_rows = read_integer(
            env_of(call, MAX_ROWS_ENV),
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

/// This build serves `SUPABASE_TOOL_MODE=user_rpc` only.
pub fn require_user_rpc_mode(raw: &str) -> Result<(), PluginError> {
    let mode = raw.trim().to_ascii_lowercase();
    if mode == USER_RPC_MODE {
        return Ok(());
    }
    if mode.is_empty() || mode == "default" {
        return Err(PluginError::invalid_input(format!(
            "This WebAssembly build serves {MODE_ENV}={USER_RPC_MODE} only; use the Node.js supabase plugin for the default mode"
        )));
    }
    Err(PluginError::invalid_input(format!(
        "{MODE_ENV} must be \"default\" or \"{USER_RPC_MODE}\", not \"{mode}\""
    )))
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

/// Refuse a function the allowlist does not name (model-written names are untrusted).
pub fn assert_function_allowed(
    name: &str,
    allowlist: Option<&[String]>,
) -> Result<(), PluginError> {
    let Some(allowlist) = allowlist else {
        return Err(PluginError::new(
            "permission_denied",
            format!("No database function may be called: set {ALLOWLIST_ENV} to the functions this agent may use"),
        ));
    };
    if allowlist.iter().any(|allowed| allowed == name) {
        return Ok(());
    }
    let shown: String = name.chars().take(80).collect();
    Err(PluginError::new(
        "permission_denied",
        format!(
            "Function \"{shown}\" is not allowed for this agent. Allowed functions: {}",
            allowlist.join(", ")
        ),
    ))
}
