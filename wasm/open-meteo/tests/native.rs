use rest_kit::client::{HttpError, HttpRequest, HttpResponse, Transport};
struct Fake;
impl Transport for Fake {
    fn send(&self, _r: &HttpRequest) -> Result<HttpResponse, HttpError> {
        Ok(HttpResponse { status: 200, headers: Default::default(), body: "{}".into() })
    }
}
#[test]
fn runs() {
    let out = rest_kit::abi::respond_tool_call(br#"{"name":"get_forecast","arguments":{"latitude":1,"longitude":2}}"#, open_meteo::SPEC, &open_meteo::OpenMeteo, &Fake);
    println!("{out}");
    assert!(!out.contains("error"));
}
