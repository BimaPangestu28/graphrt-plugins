//! Errors with the Node.js plugins' stable kinds (`invalid_input`, `auth_error`, `permission_denied`, `not_found`,
//! `rate_limited`, `api_error`, `network_error`, ...), sent to the host as `{"error": {kind, message, retryable}}`.

use serde_json::{json, Value};

/// A failed operation.
#[derive(Clone, Debug, PartialEq)]
pub struct RestError {
    pub kind: String,
    pub message: String,
    pub retryable: bool,
    /// The API's retry hint; only decides whether an immediate retry is pointless.
    pub retry_after_ms: Option<f64>,
}

impl RestError {
    /// An error of `kind` that is not retryable.
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: message.into(), retryable: false, retry_after_ms: None }
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new("invalid_input", message)
    }

    /// The kind JavaScript's `PluginError` gets without one.
    pub fn plugin(message: impl Into<String>) -> Self {
        Self::new("plugin_error", message)
    }

    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// The `error` member of a guest response.
    pub fn to_json(&self) -> Value {
        json!({"error": {"kind": self.kind, "message": self.message, "retryable": self.retryable}})
    }
}

/// `` `name` problem `` (validation errors).
pub fn invalid_argument(name: &str, problem: &str) -> RestError {
    RestError::invalid_input(format!("`{name}` {problem}"))
}
