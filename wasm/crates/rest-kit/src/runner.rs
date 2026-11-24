//! Running nodes and tools (port of `operations.mjs` `createOperationRunner` and `rest-plugin.mjs` operations):
//! argument validation, the credential (env, a node's `access_token`, or the end user's token from `tool_context`),
//! the base URL, agent tool policies, `api_request`, and tool result truncation.
//!
//! A port adds plugin-specific behaviour through [`Hooks`]; the building blocks it needs are methods of [`Kit`],
//! each doing what its Node.js counterpart does, in the same order.

use serde_json::{Map, Value};

use crate::client::{Client, RequestOptions, Transport};
use crate::error::RestError;
use crate::js;
use crate::params::validate_arguments;
use crate::request::build_rest_request;
use crate::response::{shape_rest_response, truncate_for_tool, OperationResult};
use crate::spec::Spec;
use crate::url::{decode_uri_component, encode_uri_component, Url};

const UNKNOWN_OUTCOME_MARKER: &str = "outcome unknown";
const CONTEXT_TOKEN_SECRET: &str = "access_token";
const DEFAULT_TOOL_OUTPUT_CHARS: u64 = 100_000;
const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// Who is calling: a workflow node or an agent tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Node,
    Tool,
}

/// Plugin-specific behaviour on top of the declarative spec.
pub trait Hooks {
    /// The base URL of an API whose spec has `baseUrl: null` (a function of the environment in Node.js).
    /// An error is reported as `Invalid API base URL configuration: <message>`.
    fn base_url(&self, _kit: &Kit, _api: &str) -> Result<String, RestError> {
        Err(RestError::plugin("this API needs a base_url hook"))
    }

    /// Runs operation `name` itself, or returns `None` for the declarative default.
    fn call(&self, _kit: &Kit, _name: &str, _raw_arguments: &Value) -> Option<Result<OperationResult, RestError>> {
        None
    }
}

/// One call's view of the plugin: its spec, environment, tool context and transport.
pub struct Kit<'a> {
    spec: &'a Spec,
    pub source: Source,
    env: Map<String, Value>,
    secrets: Map<String, Value>,
    context_token: Option<String>,
    transport: &'a dyn Transport,
    hooks: &'a dyn Hooks,
}

impl<'a> Kit<'a> {
    pub fn new(
        spec: &'a Spec,
        source: Source,
        env: Map<String, Value>,
        secrets: Map<String, Value>,
        transport: &'a dyn Transport,
        hooks: &'a dyn Hooks,
    ) -> Self {
        Self { spec, source, env, secrets, context_token: None, transport, hooks }
    }

    /// A host variable granted by `permissions.env` (`None` when unset).
    pub fn env(&self, name: &str) -> Option<&str> {
        self.env.get(name).and_then(Value::as_str)
    }

    /// Plugin-level settings of the spec.
    pub fn plugin(&self) -> &'static Value {
        self.spec.plugin()
    }

    /// API `name`'s settings.
    pub fn api(&self, name: &str) -> Result<&'static Value, RestError> {
        self.spec.api(name).ok_or_else(|| RestError::plugin(format!("spec has no API `{name}`")))
    }

    /// Operation `operation` of API `api`.
    pub fn operation(&self, api: &str, operation: &str) -> Result<&'static Value, RestError> {
        self.spec
            .operation(api, operation)
            .ok_or_else(|| RestError::invalid_input(format!("Unknown operation `{operation}`")))
    }

    /// Runs operation `name` with raw node config or tool arguments: `{data, next_cursor}` or the error.
    pub fn run(mut self, name: &str, raw_arguments: &Value) -> Result<OperationResult, RestError> {
        let outer =
            self.plugin()["operations"].as_array().into_iter().flatten().find(|operation| operation["name"] == name);
        let Some(outer) = outer.filter(|operation| !(operation["nodeOnly"] == true && self.source == Source::Tool))
        else {
            return Err(RestError::invalid_input(format!("Unknown operation `{name}`")));
        };
        let Some(source_env) = self.context_token_source_env() else {
            return self.run_operation_call(outer, name, raw_arguments);
        };
        let token = self.read_context_token(&source_env)?;
        for credential_env in
            self.plugin()["toolCredentialEnv"].as_array().into_iter().flatten().filter_map(Value::as_str)
        {
            self.env.remove(credential_env);
        }
        self.context_token = Some(token.clone());
        let variants = token_variants(&token);
        self.run_operation_call(outer, name, raw_arguments)
            .map(|result| OperationResult {
                data: crate::client::redact_value(result.data, &variants),
                next_cursor: crate::client::redact_value(result.next_cursor, &variants),
            })
            .map_err(|error| RestError { message: crate::client::redact_text(&error.message, &variants), ..error })
    }

    fn run_operation_call(
        &self,
        outer: &Value,
        name: &str,
        raw_arguments: &Value,
    ) -> Result<OperationResult, RestError> {
        if let Some(result) = self.hooks.call(self, name, raw_arguments) {
            return result;
        }
        let Some(api_name) = outer["api"].as_str() else {
            return Err(RestError::plugin(format!("operation `{name}` needs a hook")));
        };
        let args = self.validate(name, raw_arguments)?;
        let client = self.client(api_name, raw_arguments)?;
        if name == "api_request" {
            return self.run_api_request(&client, &args);
        }
        self.run_rest_operation(&client, name, args)
    }

    /// Validates raw arguments against outer operation `name`'s schema (`validateArguments`).
    pub fn validate(&self, name: &str, raw_arguments: &Value) -> Result<Map<String, Value>, RestError> {
        validate_arguments(self.spec.schema(name).unwrap_or(&Value::Null), raw_arguments)
    }

    /// Validates arguments against API operation `api.operation`'s own schema.
    pub fn validate_for(
        &self,
        api: &str,
        operation: &str,
        raw_arguments: &Value,
    ) -> Result<Map<String, Value>, RestError> {
        validate_arguments(&self.operation(api, operation)?["schema"], raw_arguments)
    }

    /// The client of API `api_name` for this call: credential (`pickAccessToken`) first, then the base URL.
    pub fn client(&self, api_name: &str, raw_arguments: &Value) -> Result<Client<'a>, RestError> {
        let api = self.api(api_name)?;
        let credential = self.pick_credential(api, raw_arguments)?;
        let base_url = match api["baseUrl"].as_str() {
            Some(base_url) => base_url.to_owned(),
            None => self.resolve_hook_base_url(api_name, api)?,
        };
        Ok(Client { api, api_name: api_name.to_owned(), base_url, credential })
    }

    fn resolve_hook_base_url(&self, api_name: &str, api: &Value) -> Result<String, RestError> {
        let configuration_error =
            |problem: String| RestError::invalid_input(format!("Invalid API base URL configuration: {problem}"));
        let base_url = self.hooks.base_url(self, api_name).map_err(|error| configuration_error(error.message))?;
        check_base_url(&base_url, api["allowedHostSuffix"].as_str()).map_err(configuration_error)?;
        Ok(base_url)
    }

    // `pickAccessToken` + `createCredentialResolver`: a node's (or the end user's) token wins over the env.
    fn pick_credential(&self, api: &Value, raw_arguments: &Value) -> Result<Option<String>, RestError> {
        if self.plugin()["noCredentials"] == true || api["auth"]["type"] == "none" {
            return Ok(None);
        }
        let node_token = match (&self.context_token, self.source) {
            (Some(token), _) => Some(token.clone()),
            (None, Source::Node) => raw_arguments
                .get("access_token")
                .and_then(Value::as_str)
                .map(js::trim)
                .filter(|token| !token.is_empty())
                .map(str::to_owned),
            (None, Source::Tool) => None,
        };
        if let Some(token) = node_token {
            if self.context_token.is_none() && token.chars().all(|character| character == '*') {
                let plugin = self.plugin()["name"].as_str().unwrap_or_default();
                return Err(RestError::new("auth_error", format!("The node's access_token arrived masked; trust the plugin so secrets are passed through: --trust-plugin {plugin}")));
            }
            return Ok(Some(token));
        }
        let env_name = api["auth"]["env"].as_str().unwrap_or_default();
        let value = self.env(env_name).map(js::trim).unwrap_or_default();
        if value.is_empty() {
            return Err(RestError::new(
                "auth_error",
                format!("No credential: set the {env_name} environment variable (and allow it in permissions.env)"),
            ));
        }
        Ok(Some(value.to_owned()))
    }

    fn context_token_source_env(&self) -> Option<String> {
        let source_env = self.plugin()["toolTokenSourceEnv"].as_str()?;
        if self.source != Source::Tool || self.plugin()["noCredentials"] == true {
            return None;
        }
        let mode = js::trim(self.env(source_env).unwrap_or_default()).to_ascii_lowercase();
        (!mode.is_empty() && mode != "env").then(|| source_env.to_owned())
    }

    // `readContextToken`: `<PLUGIN>_TOOL_TOKEN_SOURCE=context` takes tool tokens from `tool_context.access_token`.
    fn read_context_token(&self, source_env: &str) -> Result<String, RestError> {
        let mode = js::trim(self.env(source_env).unwrap_or_default()).to_ascii_lowercase();
        if mode != "context" {
            return Err(RestError::invalid_input(format!("{source_env} must be `env` (default) or `context`")));
        }
        let plugin = self.plugin()["name"].as_str().unwrap_or_default();
        let token = self.secrets.get(CONTEXT_TOKEN_SECRET).and_then(Value::as_str).map(js::trim).unwrap_or_default();
        let mode_note = format!("{source_env}=context");
        if token.is_empty() {
            return Err(RestError::new("auth_error", format!(
                "No per-user token: {mode_note}, so the agent's tool_context must set `{CONTEXT_TOKEN_SECRET}` for {plugin}; the env credential is not used for tools"
            )));
        }
        if token.chars().all(|character| character == '*') {
            return Err(RestError::new("auth_error", format!("The per-user token arrived masked; trust the plugin so tool context secrets are passed: --trust-plugin {plugin}")));
        }
        let is_valid = token.len() <= 8192 && token.bytes().all(|byte| (0x21..=0x7e).contains(&byte));
        if !is_valid {
            return Err(RestError::new(
                "auth_error",
                format!(
                    "The per-user token (`{CONTEXT_TOKEN_SECRET}` in tool_context) is not a valid token ({mode_note})"
                ),
            ));
        }
        Ok(token.to_owned())
    }

    /// One declarative operation of the client's API, as its `run` does: tool policy, request, shaping, and for
    /// agent tools the `toolOutput` truncation.
    pub fn run_rest_operation(
        &self,
        client: &Client,
        name: &str,
        args: Map<String, Value>,
    ) -> Result<OperationResult, RestError> {
        let operation = self.operation(&client.api_name, name)?;
        self.assert_tool_policy(operation)?;
        let operation_client = match operation["baseUrl"].as_str() {
            Some(base_url) => Client {
                base_url: base_url.to_owned(),
                credential: if operation["sendCredential"] == false { None } else { client.credential.clone() },
                ..client.clone()
            },
            None => client.clone(),
        };
        let request = build_rest_request(operation, &args, &operation_client.base_url)?;
        let response =
            operation_client.send(request, self.transport).map_err(|error| describe_write_outcome(operation, error))?;
        let result = shape_rest_response(operation, response, &args);
        if self.source != Source::Tool {
            return Ok(result);
        }
        let default_output = serde_json::json!({"maxChars": DEFAULT_TOOL_OUTPUT_CHARS});
        let tool_output = [operation.get("toolOutput"), client.api.get("toolOutput")]
            .into_iter()
            .flatten()
            .find(|output| !output.is_null())
            .unwrap_or(&default_output);
        Ok(OperationResult { data: truncate_for_tool(result.data, tool_output), ..result })
    }

    fn assert_tool_policy(&self, operation: &Value) -> Result<(), RestError> {
        let Some(env_name) = operation["toolPolicy"].as_str().and_then(|policy| policy.strip_prefix("optIn:")) else {
            return Ok(());
        };
        if self.source != Source::Tool || self.env(env_name) == Some("1") {
            return Ok(());
        }
        let name = operation["name"].as_str().unwrap_or_default();
        Err(RestError::new(
            "permission_denied",
            format!("`{name}` is disabled for agent tools; set {env_name}=1 to allow it, or use a workflow node"),
        ))
    }

    /// `api_request`: any endpoint on the API's own origin; GET only for agent tools.
    pub fn run_api_request(&self, client: &Client, args: &Map<String, Value>) -> Result<OperationResult, RestError> {
        let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
        self.assert_api_request_path_allowed(client.api, path)?;
        if !path.starts_with('/') {
            return Err(RestError::invalid_input("`path` must start with \"/\" and be relative to the API base URL"));
        }
        let method = args.get("method").and_then(Value::as_str).unwrap_or("GET").to_ascii_uppercase();
        if self.source == Source::Tool && method != "GET" {
            return Err(RestError::new("permission_denied", format!(
                "api_request is read-only (GET) when called as an agent tool; use a dedicated operation, or a workflow node for {method}"
            )));
        }
        let body = args.get("body").cloned();
        if body.is_some() && (method == "GET" || method == "DELETE") {
            return Err(RestError::invalid_input(format!("`body` is not allowed with {method}; use `query`")));
        }
        let query = args.get("query").and_then(Value::as_object).cloned().unwrap_or_default();
        let options = RequestOptions { method, path: path.to_owned(), query, json: body, ..RequestOptions::default() };
        let response = client.send(options, self.transport)?;
        Ok(OperationResult::data(response.body))
    }

    // GET operations an agent may not call must not be reachable through api_request either.
    fn assert_api_request_path_allowed(&self, api: &Value, path: &str) -> Result<(), RestError> {
        if self.source != Source::Tool {
            return Ok(());
        }
        let pathname = normalize_tool_pathname(path.split(['?', '#']).next().unwrap_or_default());
        for protected in api["protectedPaths"].as_array().into_iter().flatten() {
            let opted_in = protected["optInEnv"].as_str().is_some_and(|env_name| self.env(env_name) == Some("1"));
            if !opted_in && template_matches(protected["path"].as_str().unwrap_or_default(), &pathname) {
                let name = protected["operation"].as_str().unwrap_or_default();
                return Err(RestError::new("permission_denied", format!("api_request cannot reach the path of `{name}` as an agent tool; use that operation or a workflow node")));
            }
        }
        Ok(())
    }
}

fn token_variants(token: &str) -> Vec<String> {
    let encoded = encode_uri_component(token);
    if encoded == token {
        vec![token.to_owned()]
    } else {
        vec![token.to_owned(), encoded]
    }
}

/// `checkBaseUrl`: https (http only on localhost), no credentials, under `allowedHostSuffix`.
pub fn check_base_url(base_url: &str, allowed_host_suffix: Option<&str>) -> Result<(), String> {
    let Some(url) = Url::parse(base_url) else {
        return Err(format!("`baseUrl` {} is not a valid URL", js::json_string(base_url)));
    };
    let is_local_http = url.scheme == "http" && LOCAL_HOSTS.contains(&url.host.as_str());
    if url.scheme != "https" && !is_local_http {
        return Err(format!("`baseUrl` {base_url} must use https (http only on localhost)"));
    }
    if !url.username.is_empty() || !url.password.is_empty() {
        return Err(format!("`baseUrl` {base_url} must not contain credentials"));
    }
    if let Some(suffix) = allowed_host_suffix {
        if !url.host.to_ascii_lowercase().ends_with(&suffix.to_ascii_lowercase()) {
            return Err(format!("`baseUrl` host {} is not under allowedHostSuffix {suffix}", url.host));
        }
    }
    Ok(())
}

// A write whose outcome is unknown gets the operation's `checkHint` and is not retried by the caller.
fn describe_write_outcome(operation: &Value, error: RestError) -> RestError {
    let Some(hint) = operation["checkHint"].as_str() else { return error };
    if !error.message.contains(UNKNOWN_OUTCOME_MARKER) {
        return error;
    }
    RestError { message: format!("{}. To check: {hint}", error.message), retryable: false, ..error }
}

// Decoded until stable and repeated slashes collapsed, so "%252F" and "//" cannot hide a protected path.
fn normalize_tool_pathname(pathname: &str) -> String {
    let mut decoded = pathname.to_owned();
    for _ in 0..4 {
        match decode_uri_component(&decoded) {
            Some(next) if next != decoded => decoded = next,
            _ => break,
        }
    }
    let mut collapsed = String::with_capacity(decoded.len());
    for character in decoded.chars() {
        let character = if character == '\\' { '/' } else { character };
        if !(character == '/' && collapsed.ends_with('/')) {
            collapsed.push(character);
        }
    }
    collapsed
}

#[derive(Debug)]
enum TemplatePart {
    Literal(String),
    Segment,
    Rest,
}

// `templateToPattern`: `{name}` is `[^/]+`, `{+name}` is `.+`, case-insensitive, optional trailing slash.
fn template_matches(template: &str, pathname: &str) -> bool {
    let mut parts = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|offset| open + offset) else { break };
        parts.push(TemplatePart::Literal(rest[..open].to_ascii_lowercase()));
        parts.push(if rest[open + 1..].starts_with('+') { TemplatePart::Rest } else { TemplatePart::Segment });
        rest = &rest[close + 1..];
    }
    parts.push(TemplatePart::Literal(rest.strip_suffix('/').unwrap_or(rest).to_ascii_lowercase()));
    let lowered = pathname.to_ascii_lowercase();
    let target = lowered.strip_suffix('/').unwrap_or(&lowered);
    match_parts(&parts, target) || match_parts(&parts, &lowered)
}

fn match_parts(parts: &[TemplatePart], text: &str) -> bool {
    let Some((first, rest)) = parts.split_first() else { return text.is_empty() };
    match first {
        TemplatePart::Literal(literal) => {
            text.strip_prefix(literal.as_str()).is_some_and(|remaining| match_parts(rest, remaining))
        }
        TemplatePart::Segment => (1..=text.len())
            .filter(|end| text.is_char_boundary(*end))
            .take_while(|end| !text[..*end].contains('/'))
            .any(|end| match_parts(rest, &text[end..])),
        TemplatePart::Rest => {
            (1..=text.len()).filter(|end| text.is_char_boundary(*end)).any(|end| match_parts(rest, &text[end..]))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_paths_match_like_the_regex() {
        assert!(template_matches("/v1/accounts/{id}/secrets", "/V1/accounts/42/secrets/"));
        assert!(!template_matches("/v1/accounts/{id}/secrets", "/v1/accounts/4/2/secrets"));
        assert!(template_matches("/files/{+path}", "/files/a/b"));
        assert_eq!(normalize_tool_pathname("/a%252F%2Fb//c"), "/a/b/c");
    }
}
