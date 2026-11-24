//! WebAssembly builds of the supabase plugin's agent tools.
//!
//! One crate, two modules, because a module describes its tools before it sees env (the
//! Node.js plugin picks its tool set from `SUPABASE_TOOL_MODE` at start):
//! - default build, `wasm/supabase/supabase.wasm`: the default tool mode, every tool of the
//!   Node.js plugin except `download_object` ([`operations`]);
//! - feature `user-rpc`, `wasm/supabase-rpc/supabase_rpc.wasm`: `SUPABASE_TOOL_MODE=user_rpc`,
//!   one `call_function` tool as the signed-in end user, whose JWT comes from the agent's
//!   per-call `tool_context` ([`user_rpc`]).
//!
//! Same env contract, tool names, schemas, error kinds and messages as the Node.js plugin;
//! `wasm/test` runs shared cases against both.

use graphrt_wasm_guest::{
    export_plugin, Manifest, Output, Plugin, PluginError, Request, ToolCall, ToolResult,
};

mod limits;
mod project_url;
mod response;
mod settings;

#[cfg(not(feature = "user-rpc"))]
mod args;
#[cfg(not(feature = "user-rpc"))]
mod client;
#[cfg(not(feature = "user-rpc"))]
mod js;
#[cfg(feature = "user-rpc")]
mod jwt;
#[cfg(not(feature = "user-rpc"))]
mod operations;
#[cfg(not(feature = "user-rpc"))]
mod postgrest;
#[cfg(not(feature = "user-rpc"))]
mod upload;
#[cfg(not(feature = "user-rpc"))]
mod url;
#[cfg(feature = "user-rpc")]
mod user_rpc;

struct Supabase;

impl Plugin for Supabase {
    fn manifest() -> Manifest {
        describe(Manifest::new("supabase", env!("CARGO_PKG_VERSION")))
    }

    fn run(request: Request) -> Result<Output, PluginError> {
        Err(PluginError::new(
            "invalid_input",
            format!(
                "node kind `{}`: this WebAssembly build only serves agent tools; use the Node.js plugin for workflow nodes",
                request.kind
            ),
        ))
    }

    #[cfg(not(feature = "user-rpc"))]
    fn call_tool(call: ToolCall) -> Result<ToolResult, PluginError> {
        operations::call_tool(&call)
    }

    #[cfg(feature = "user-rpc")]
    fn call_tool(call: ToolCall) -> Result<ToolResult, PluginError> {
        if call.name != user_rpc::TOOL_NAME {
            return Err(PluginError::new(
                "invalid_input",
                format!("Unknown operation `{}`", call.name),
            ));
        }
        let data = user_rpc::call_function_as_user(&call)?;
        Ok(ToolResult::json(
            graphrt_wasm_guest::json!({ "data": data, "next_cursor": null }),
        ))
    }
}

#[cfg(not(feature = "user-rpc"))]
fn describe(manifest: Manifest) -> Manifest {
    let manifest = manifest.describe("Supabase agent tools (default tool mode), WebAssembly build");
    operations::tool_specs()
        .into_iter()
        .fold(manifest, |manifest, spec| {
            let text = |key: &str| {
                spec.get(key)
                    .and_then(graphrt_wasm_guest::Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            let parameters = spec.get("parameters").cloned().unwrap_or_default();
            manifest.tool(&text("name"), &text("description"), parameters)
        })
}

#[cfg(feature = "user-rpc")]
fn describe(manifest: Manifest) -> Manifest {
    manifest
        .describe("Supabase per-user RPC tool (SUPABASE_TOOL_MODE=user_rpc), WebAssembly build")
        .tool(
            user_rpc::TOOL_NAME,
            user_rpc::TOOL_DESCRIPTION,
            user_rpc::tool_parameters(),
        )
}

export_plugin!(Supabase, tools);

/// A host variable granted by `permissions.env`, `""` when unset.
pub(crate) fn env_of<'a>(call: &'a ToolCall, name: &str) -> &'a str {
    call.env(name).unwrap_or_default()
}
