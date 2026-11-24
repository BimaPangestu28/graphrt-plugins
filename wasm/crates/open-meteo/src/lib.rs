//! WebAssembly build of the open-meteo plugin: entirely declarative (manifest.json and spec.jsonl are exported
//! from open-meteo/definition.mjs), no hooks.

/// open-meteo needs no plugin-specific code.
pub struct OpenMeteo;

impl rest_kit::Hooks for OpenMeteo {}

pub const MANIFEST: &str = include_str!("../manifest.json");
pub const SPEC: &str = include_str!("../spec.jsonl");

rest_kit::export_rest_plugin!(MANIFEST, SPEC, OpenMeteo);
