//! Requests to the project API with the plugin's credential (port of the shared client's
//! `sendWithRetries` for one attempt, and of `authorizeSupabase`): `apikey` is
//! `SUPABASE_KEY`; `Authorization` is `Bearer <SUPABASE_USER_JWT>`, or `Bearer <key>` for a
//! legacy (JWT) key. Every credential is redacted from results and errors.
//!
//! The Node.js client retries 429s, and 5xx and network failures of requests that are safe to
//! repeat, after a back-off; a guest cannot sleep, so this client sends once and reports the
//! same error (with the same `retryable` flag) for the caller to retry.

use std::collections::BTreeMap;

use graphrt_wasm_guest::{http, HttpRequest, HttpResponse, PluginError, ToolCall, Value};

use crate::response::{self, Secrets, UNKNOWN_OUTCOME_NOTE};
use crate::settings::{require_credential, KEY_ENV};
use crate::{env_of, js, project_url, url};

const USER_JWT_ENV: &str = "SUPABASE_USER_JWT";
const LEGACY_JWT_PREFIX: &str = "eyJ";
/// The shared client's per-attempt timeout.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// A request body as the host takes it.
pub enum Body {
    Text(String),
    Base64(String),
}

/// One request to the project API.
pub struct ApiRequest {
    pub method: &'static str,
    /// Path (and query) on the project origin, starting with `/`.
    pub path: String,
    /// `url.searchParams.set` entries (api_request's `query`).
    pub query: Vec<(String, String)>,
    /// Lower-case names; `accept: application/json` unless set.
    pub headers: BTreeMap<String, String>,
    pub body: Option<Body>,
    /// Safe to repeat: 5xx and network errors are retryable and have no "outcome unknown" note.
    pub idempotent: bool,
    pub timeout_ms: u64,
}

impl ApiRequest {
    pub fn new(method: &'static str, path: String) -> Self {
        Self {
            method,
            path,
            query: Vec::new(),
            headers: BTreeMap::new(),
            body: None,
            idempotent: matches!(method, "GET" | "HEAD" | "PUT" | "DELETE"),
            timeout_ms: DEFAULT_TIMEOUT_MS,
        }
    }
}

/// A sent request's failure before any response: the host's error kind and message.
pub struct TransportFailure {
    pub kind: String,
    pub message: String,
}

/// The project origin and the credentials of one tool call.
pub struct Client {
    origin: String,
    key: String,
    authorization: Option<String>,
    secrets: Secrets,
}

impl Client {
    /// Credential first, then the project URL, like the Node.js runner.
    pub fn from_env(call: &ToolCall) -> Result<Self, PluginError> {
        let key = require_credential(env_of(call, KEY_ENV))?;
        let origin = project_url::resolve(env_of(call, project_url::URL_ENV))?;
        let user_jwt = Some(env_of(call, USER_JWT_ENV).trim()).filter(|jwt| !jwt.is_empty());
        let authorization = match user_jwt {
            Some(jwt) => Some(format!("Bearer {jwt}")),
            None if key.starts_with(LEGACY_JWT_PREFIX) => Some(format!("Bearer {key}")),
            None => None,
        };
        let secrets = collect_secrets(authorization.as_deref(), &key, user_jwt);
        Ok(Self {
            origin,
            key,
            authorization,
            secrets,
        })
    }

    pub fn secrets(&self) -> &Secrets {
        &self.secrets
    }

    /// Send `request`; the redacted body of a 2xx response, or the error the API or transport reported.
    pub fn send(&self, request: ApiRequest) -> Result<Value, PluginError> {
        let idempotent = request.idempotent;
        let reply = self
            .send_raw(request)?
            .map_err(|failure| self.transport_error(&failure, idempotent))?;
        response::decode(reply, &self.secrets, idempotent)
    }

    /// Send `request` and hand back the host's reply or transport failure as it is.
    pub fn send_raw(
        &self,
        request: ApiRequest,
    ) -> Result<Result<HttpResponse, TransportFailure>, PluginError> {
        let url = url::resolve(&self.origin, &request.path)?;
        let mut headers = BTreeMap::from([("accept".to_owned(), "application/json".to_owned())]);
        headers.extend(request.headers);
        headers.insert("apikey".into(), self.key.clone());
        if let Some(authorization) = &self.authorization {
            headers.insert("authorization".into(), authorization.clone());
        }
        let (body, body_base64) = match request.body {
            Some(Body::Text(text)) => (Some(text), None),
            Some(Body::Base64(encoded)) => (None, Some(encoded)),
            None => (None, None),
        };
        let host_request = HttpRequest {
            method: request.method.into(),
            url: url::set_query_values(&url, &request.query),
            headers,
            body,
            body_base64,
            timeout_ms: Some(request.timeout_ms),
            ..HttpRequest::default()
        };
        Ok(http(&host_request).map_err(|error| TransportFailure {
            kind: error.kind,
            message: error.message,
        }))
    }

    /// `Network error: ...`, with the unknown-outcome note for requests that are not safe to repeat.
    pub fn transport_error(&self, failure: &TransportFailure, idempotent: bool) -> PluginError {
        let reason = if failure.kind == "timeout" {
            "request timed out"
        } else {
            failure.message.as_str()
        };
        let note = if idempotent { "" } else { UNKNOWN_OUTCOME_NOTE };
        let mut error = PluginError::new(
            "network_error",
            self.secrets
                .redact(&format!("Network error: {reason}{note}")),
        );
        error.retryable = idempotent && failure.kind != "egress_denied";
        error
    }
}

/// The shared client's `collectSecrets`: the Authorization header, the credential (raw and
/// URL-encoded) and the user JWT, then each without its `Bearer ` prefix.
fn collect_secrets(authorization: Option<&str>, key: &str, user_jwt: Option<&str>) -> Secrets {
    let mut values: Vec<String> = authorization.into_iter().map(str::to_owned).collect();
    values.push(key.to_owned());
    values.push(js::encode_uri_component(key));
    values.extend(user_jwt.map(str::to_owned));
    let stripped: Vec<String> = values
        .iter()
        .map(|value| strip_scheme(value).to_owned())
        .collect();
    Secrets::from_values(values.into_iter().chain(stripped))
}

/// `value.replace(/^(Bearer|Basic)\s+/i, "")`
fn strip_scheme(value: &str) -> &str {
    for scheme in ["bearer", "basic"] {
        let matches = value.len() > scheme.len()
            && value.is_char_boundary(scheme.len())
            && value[..scheme.len()].eq_ignore_ascii_case(scheme);
        if matches {
            let rest = &value[scheme.len()..];
            let trimmed = rest.trim_start();
            if trimmed.len() < rest.len() {
                return trimmed;
            }
        }
    }
    value
}
