//! The ABI layer natively (the parity tests in wasm/test run the built module): a tool call and a node run go
//! through `respond_tool_call` / `respond_run` with a fake `graphrt::http`.

use std::cell::RefCell;

use rest_kit::client::{HttpError, HttpRequest, HttpResponse, Transport};

/// Answers every request with `body` and records the URLs.
struct FakeHost {
    body: &'static str,
    urls: RefCell<Vec<String>>,
}

impl Transport for FakeHost {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, HttpError> {
        self.urls.borrow_mut().push(request.url.clone());
        Ok(HttpResponse { status: 200, headers: Default::default(), body: self.body.into() })
    }
}

#[test]
fn a_tool_call_returns_text_and_data() {
    let host = FakeHost { body: r#"{"elevation":768.0}"#, urls: RefCell::default() };
    let request = br#"{"name":"get_forecast","arguments":{"latitude":1,"longitude":2,"current":[]}}"#;
    let response = rest_kit::abi::respond_tool_call(request, open_meteo::SPEC, &open_meteo::OpenMeteo, &host);
    let expected_output = r#"{"data":{"elevation":768},"next_cursor":null}"#;
    assert_eq!(
        response,
        format!(r#"{{"text":{},"data":{expected_output}}}"#, rest_kit::js::json_string(expected_output))
    );
    let urls = host.urls.borrow();
    assert!(
        urls[0].starts_with("https://api.open-meteo.com/v1/forecast?latitude=1&longitude=2&current=&daily="),
        "{urls:?}"
    );
}

#[test]
fn a_node_run_returns_outputs_or_an_error() {
    let host = FakeHost { body: r#"{"results":[{"name":"Bandung"}]}"#, urls: RefCell::default() };
    let request = br#"{"kind":"open-meteo.search_locations","node_id":"n","config":{"name":"Bandung"},"attempt":1}"#;
    let response = rest_kit::abi::respond_run(request, open_meteo::SPEC, &open_meteo::OpenMeteo, &host);
    assert_eq!(response, r#"{"outputs":{"data":[{"name":"Bandung"}],"next_cursor":null}}"#);
    let refused = br#"{"kind":"open-meteo.search_locations","node_id":"n","config":{},"attempt":1}"#;
    let response = rest_kit::abi::respond_run(refused, open_meteo::SPEC, &open_meteo::OpenMeteo, &host);
    assert_eq!(response, r#"{"error":{"kind":"invalid_input","message":"`name` is required","retryable":false}}"#);
}
