//! Credentials of a bearer API: env, a node's `access_token`, and the end user's token from `tool_context`
//! (`<PLUGIN>_TOOL_TOKEN_SOURCE=context`), with redaction of whichever is sent. The ported plugins use no credential
//! or an env key only, so these paths are tested here with a fixture spec.

use std::cell::RefCell;

use rest_kit::client::{HttpError, HttpRequest, HttpResponse, Transport};
use rest_kit::spec::Spec;
use rest_kit::{json, Hooks, Kit, Map, Source, Value};

const SPEC: &str = concat!(
    r#"{"plugin":{"name":"acme","version":"0.1.0","tokenEnv":"ACME_TOKEN","noCredentials":false,"toolTokenSourceEnv":"ACME_TOOL_TOKEN_SOURCE","toolCredentialEnv":["ACME_TOKEN"],"operations":[{"name":"get_me","nodeOnly":false,"api":"main"}]}}"#,
    "\n",
    r#"{"schema":"get_me","value":{"properties":{},"required":[]}}"#,
    "\n",
    r#"{"api":"main","value":{"name":"acme","baseUrl":"https://api.acme.test","auth":{"type":"bearer","env":"ACME_TOKEN"},"errors":{"messagePath":"message"},"defaultHeaders":{},"protectedPaths":[]}}"#,
    "\n",
    r#"{"operation":"main/get_me","value":{"name":"get_me","method":"GET","path":"/me","params":{},"write":"read","bodyMode":"json"}}"#,
    "\n",
);

struct NoHooks;
impl Hooks for NoHooks {}

/// Echoes the Authorization header it receives in the body (an API that leaks it back).
#[derive(Default)]
struct EchoHost {
    authorizations: RefCell<Vec<String>>,
}

impl Transport for EchoHost {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, HttpError> {
        let authorization = request.headers.get("authorization").cloned().unwrap_or_default();
        self.authorizations.borrow_mut().push(authorization.clone());
        Ok(HttpResponse { status: 200, headers: Default::default(), body: json!({"echo": authorization}).to_string() })
    }
}

fn run(
    source: Source,
    env: Value,
    secrets: Value,
    arguments: Value,
) -> (Result<rest_kit::OperationResult, rest_kit::RestError>, Vec<String>) {
    let spec = Spec::new(SPEC).unwrap();
    let host = EchoHost::default();
    let as_map = |value: Value| value.as_object().cloned().unwrap_or_else(Map::new);
    let outcome = Kit::new(&spec, source, as_map(env), as_map(secrets), &host, &NoHooks).run("get_me", &arguments);
    let authorizations = host.authorizations.borrow().clone();
    (outcome, authorizations)
}

#[test]
fn env_token_is_sent_and_redacted() {
    let (outcome, sent) = run(Source::Tool, json!({"ACME_TOKEN": " env-secret-1 "}), json!({}), json!({}));
    assert_eq!(sent, ["Bearer env-secret-1"]);
    assert_eq!(outcome.unwrap().data, json!({"echo": "[redacted]"}));
}

#[test]
fn missing_env_token_is_an_auth_error() {
    let (outcome, sent) = run(Source::Tool, json!({}), json!({}), json!({}));
    let error = outcome.unwrap_err();
    assert_eq!((error.kind.as_str(), sent.len()), ("auth_error", 0));
    assert_eq!(
        error.message,
        "No credential: set the ACME_TOKEN environment variable (and allow it in permissions.env)"
    );
}

#[test]
fn a_node_access_token_wins_and_a_tool_cannot_pass_one() {
    let env = json!({"ACME_TOKEN": "env-secret-1"});
    let (_, sent) = run(Source::Node, env.clone(), json!({}), json!({"access_token": "node-secret-2"}));
    assert_eq!(sent, ["Bearer node-secret-2"]);
    let (_, sent) = run(Source::Tool, env.clone(), json!({}), json!({"access_token": "node-secret-2"}));
    assert_eq!(sent, ["Bearer env-secret-1"]);
    let (outcome, _) = run(Source::Node, env, json!({}), json!({"access_token": "****"}));
    assert!(outcome.unwrap_err().message.contains("--trust-plugin acme"));
}

#[test]
fn context_mode_uses_the_end_users_token_never_the_env() {
    let env = json!({"ACME_TOKEN": "env-secret-1", "ACME_TOOL_TOKEN_SOURCE": "Context"});
    let (outcome, sent) = run(Source::Tool, env.clone(), json!({"access_token": "user-token-3"}), json!({}));
    assert_eq!(sent, ["Bearer user-token-3"]);
    assert_eq!(outcome.unwrap().data, json!({"echo": "[redacted]"}));
    let (outcome, sent) = run(Source::Tool, env.clone(), json!({}), json!({}));
    assert!(sent.is_empty());
    assert!(outcome.unwrap_err().message.starts_with("No per-user token: ACME_TOOL_TOKEN_SOURCE=context"));
    let (outcome, _) = run(Source::Tool, env.clone(), json!({"access_token": "******"}), json!({}));
    assert!(outcome.unwrap_err().message.contains("arrived masked"));
    let (outcome, _) = run(Source::Tool, env.clone(), json!({"access_token": "has space"}), json!({}));
    assert!(outcome.unwrap_err().message.contains("is not a valid token"));
    // Nodes keep the env credential.
    let (_, sent) = run(Source::Node, env, json!({"access_token": "user-token-3"}), json!({}));
    assert_eq!(sent, ["Bearer env-secret-1"]);
}

#[test]
fn a_bad_token_source_refuses_every_tool_call() {
    let env = json!({"ACME_TOKEN": "env-secret-1", "ACME_TOOL_TOKEN_SOURCE": "user"});
    let (outcome, sent) = run(Source::Tool, env, json!({"access_token": "user-token-3"}), json!({}));
    let error = outcome.unwrap_err();
    assert_eq!(
        (error.kind.as_str(), error.message.as_str(), sent.len()),
        ("invalid_input", "ACME_TOOL_TOKEN_SOURCE must be `env` (default) or `context`", 0)
    );
}
