//! The graphrt WebAssembly ABI (version 1) for a rest-kit plugin: `graphrt_describe` hands out the embedded
//! manifest as is, `graphrt_run` and `graphrt_tool_call` parse the embedded spec and run one operation. Outputs
//! are written with JavaScript's number formatting, so results are the Node.js plugin's bytes.

use serde_json::{json, Map, Value};

use crate::client::Transport;
use crate::error::RestError;
use crate::js;
use crate::runner::{Hooks, Kit, Source};
use crate::spec::Spec;

/// A buffer of `len` bytes for the host to write a request into (never freed: one instance per call).
pub fn alloc(len: i32) -> i32 {
    let buffer = vec![0u8; len.max(0) as usize].into_boxed_slice();
    Box::leak(buffer).as_mut_ptr() as usize as i32
}

fn pack(bytes: &'static [u8]) -> i64 {
    (((bytes.as_ptr() as usize as u64) << 32) | bytes.len() as u64) as i64
}

fn leak(text: String) -> i64 {
    pack(Box::leak(text.into_bytes().into_boxed_slice()))
}

/// `graphrt_describe`: the manifest text, embedded at build time.
pub fn describe(manifest: &'static str) -> i64 {
    pack(manifest.as_bytes())
}

/// # Safety
/// `ptr`/`len` must be a buffer the host wrote through [`alloc`].
unsafe fn input<'a>(ptr: i32, len: i32) -> &'a [u8] {
    std::slice::from_raw_parts(ptr as usize as *const u8, len.max(0) as usize)
}

/// `graphrt_run`.
pub fn run(ptr: i32, len: i32, spec: &'static str, hooks: &dyn Hooks) -> i64 {
    // SAFETY: the host wrote `len` bytes at `ptr`, a buffer from `alloc`.
    leak(respond_run(unsafe { input(ptr, len) }, spec, hooks, &crate::client::HostTransport))
}

/// `graphrt_tool_call`.
pub fn tool_call(ptr: i32, len: i32, spec: &'static str, hooks: &dyn Hooks) -> i64 {
    // SAFETY: the host wrote `len` bytes at `ptr`, a buffer from `alloc`.
    leak(respond_tool_call(unsafe { input(ptr, len) }, spec, hooks, &crate::client::HostTransport))
}

fn object_at(request: &Value, pointer: &str) -> Map<String, Value> {
    request.pointer(pointer).and_then(Value::as_object).cloned().unwrap_or_default()
}

/// A node run request (`{kind, config, env}`) to its response JSON.
pub fn respond_run(input: &[u8], spec_text: &'static str, hooks: &dyn Hooks, transport: &dyn Transport) -> String {
    let outcome = parse(input, spec_text).and_then(|(request, spec)| {
        let kind = request["kind"].as_str().unwrap_or_default();
        let name = spec.plugin()["name"]
            .as_str()
            .and_then(|plugin| kind.strip_prefix(plugin))
            .and_then(|rest| rest.strip_prefix('.'))
            .unwrap_or(kind);
        let kit = Kit::new(&spec, Source::Node, object_at(&request, "/env"), Map::new(), transport, hooks);
        kit.run(name, request.get("config").unwrap_or(&Value::Null))
    });
    match outcome {
        Ok(result) => js::stringify(&json!({"outputs": result.to_json()})),
        Err(error) => js::stringify(&error.to_json()),
    }
}

/// A tool call (`{name, arguments, context, env}`) to its response JSON: `{text, data}` or `{error}`.
pub fn respond_tool_call(
    input: &[u8],
    spec_text: &'static str,
    hooks: &dyn Hooks,
    transport: &dyn Transport,
) -> String {
    let outcome = parse(input, spec_text).and_then(|(request, spec)| {
        let name = request["name"].as_str().unwrap_or_default().to_owned();
        let kit = Kit::new(
            &spec,
            Source::Tool,
            object_at(&request, "/env"),
            object_at(&request, "/context/secrets"),
            transport,
            hooks,
        );
        kit.run(&name, request.get("arguments").unwrap_or(&Value::Null))
    });
    match outcome {
        Ok(result) => {
            let output = result.to_json();
            js::stringify(&json!({"text": js::stringify(&output), "data": output}))
        }
        Err(error) => js::stringify(&error.to_json()),
    }
}

fn parse(input: &[u8], spec_text: &'static str) -> Result<(Value, Spec), RestError> {
    // serde_json's error text would link float formatting into the module; the host only sends valid JSON.
    let request = serde_json::from_slice(input)
        .map_err(|_| RestError::new("invalid_request", "the request is not valid JSON"))?;
    Ok((request, Spec::new(spec_text)?))
}
