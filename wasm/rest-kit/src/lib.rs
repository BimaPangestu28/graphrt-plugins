//! rest-kit: one small runtime for graphrt WebAssembly builds of declarative REST plugins.
//!
//! A plugin is data: `manifest.json` (its nodes and tools) and `spec.json` (APIs, operations, params, auth,
//! errors, pagination, limits), both exported from the Node.js plugin's `defineRestPlugin` definition by
//! `wasm/scripts/export-rest-spec.mjs` and embedded in the plugin's module at build time. Plugin-specific code is a
//! small [`Hooks`] implementation. The behaviour is a port of `shared/lib` (rest-plugin, rest-request,
//! rest-response, rest-errors, rest-auth, api-client, params, operations), with the same requests, results, error
//! kinds and messages; `wasm/test` checks that against the Node.js plugins.
//!
//! ```ignore
//! struct NoHooks;
//! impl rest_kit::Hooks for NoHooks {}
//! rest_kit::export_rest_plugin!(include_str!("../manifest.json"), include_str!("../spec.json"), NoHooks);
//! ```

pub mod abi;
pub mod client;
pub mod error;
pub mod js;
pub mod params;
pub mod path;
pub mod request;
pub mod response;
pub mod runner;
pub mod url;

pub use client::{Client, Transport};
pub use error::RestError;
pub use response::OperationResult;
pub use runner::{Hooks, Kit, Source};
pub use serde_json::{self, json, Map, Value};

/// Exports the ABI functions of a rest-kit plugin: `(manifest text, spec text, hooks value)`.
#[macro_export]
macro_rules! export_rest_plugin {
    ($manifest:expr, $spec:expr, $hooks:expr) => {
        #[no_mangle]
        pub extern "C" fn graphrt_abi_version() -> i32 {
            1
        }
        #[no_mangle]
        pub extern "C" fn graphrt_alloc(len: i32) -> i32 {
            $crate::abi::alloc(len)
        }
        #[no_mangle]
        pub extern "C" fn graphrt_describe() -> i64 {
            $crate::abi::describe($manifest)
        }
        #[no_mangle]
        pub extern "C" fn graphrt_run(ptr: i32, len: i32) -> i64 {
            $crate::abi::run(ptr, len, $spec, &$hooks)
        }
        #[no_mangle]
        pub extern "C" fn graphrt_tool_call(ptr: i32, len: i32) -> i64 {
            $crate::abi::tool_call(ptr, len, $spec, &$hooks)
        }
    };
}
