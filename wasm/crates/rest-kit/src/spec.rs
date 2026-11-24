//! The embedded spec (`spec.jsonl`): one compact JSON document per line, so a call parses only what it uses.
//!
//! ```text
//! {"plugin":{"name":..,"operations":[{"name":..,"nodeOnly":..,"api":..}],..}}
//! {"schema":"<operation>","value":{"properties":..,"required":..}}
//! {"api":"<api>","value":{"baseUrl":..,"auth":..,"errors":..,..}}
//! {"operation":"<api>/<operation>","value":{"method":..,"path":..,"params":..,"schema":..,..}}
//! ```
//!
//! Parsing all of it costs about half of a call in the interpreter; a lookup is a substring search and one small
//! parse. Parsed parts live until the instance is dropped (one instance per call), so they are leaked on purpose.

use std::cell::RefCell;

use serde_json::Value;

use crate::error::RestError;

/// Lazily parsed lines of a spec.
pub struct Spec {
    text: &'static str,
    plugin: &'static Value,
    parsed: RefCell<Vec<(String, &'static Value)>>,
}

impl Spec {
    /// Reads the `plugin` line; the others are parsed when first used.
    pub fn new(text: &'static str) -> Result<Spec, RestError> {
        let first_line = text.lines().next().unwrap_or_default();
        let plugin = parse_line(first_line).and_then(|mut line| line.get_mut("plugin").map(Value::take));
        let plugin = plugin.ok_or_else(|| RestError::plugin("the embedded spec has no plugin line"))?;
        Ok(Spec { text, plugin: leak(plugin), parsed: RefCell::new(Vec::new()) })
    }

    /// Plugin-level settings: name, version, credentials, outer operations.
    pub fn plugin(&self) -> &'static Value {
        self.plugin
    }

    /// The outer operation `name`'s argument schema.
    pub fn schema(&self, name: &str) -> Option<&'static Value> {
        self.lookup("schema", name)
    }

    /// API `name`'s settings (without its operations).
    pub fn api(&self, name: &str) -> Option<&'static Value> {
        self.lookup("api", name)
    }

    /// Operation `operation` of API `api`.
    pub fn operation(&self, api: &str, operation: &str) -> Option<&'static Value> {
        self.lookup("operation", &format!("{api}/{operation}"))
    }

    fn lookup(&self, kind: &str, key: &str) -> Option<&'static Value> {
        let cache_key = format!("{kind}\n{key}");
        if let Some((_, value)) = self.parsed.borrow().iter().find(|(cached, _)| *cached == cache_key) {
            return Some(value);
        }
        let prefix = format!("{{\"{kind}\":{},\"value\":", crate::js::json_string(key));
        let line = self.text.lines().find(|line| line.starts_with(&prefix))?;
        let value = leak(parse_line(line)?.get_mut("value").map(Value::take)?);
        self.parsed.borrow_mut().push((cache_key, value));
        Some(value)
    }
}

fn parse_line(line: &str) -> Option<Value> {
    serde_json::from_str(line).ok()
}

fn leak(value: Value) -> &'static Value {
    Box::leak(Box::new(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_up_lines() {
        let text = "{\"plugin\":{\"name\":\"p\"}}\n{\"schema\":\"a\",\"value\":{\"required\":[]}}\n{\"api\":\"main\",\"value\":{\"baseUrl\":\"https://x\"}}\n{\"operation\":\"main/a\",\"value\":{\"path\":\"/a\"}}\n";
        let spec = Spec::new(text).unwrap();
        assert_eq!(spec.plugin()["name"], "p");
        assert_eq!(spec.api("main").unwrap()["baseUrl"], "https://x");
        assert_eq!(spec.operation("main", "a").unwrap()["path"], "/a");
        assert_eq!(spec.operation("main", "a").unwrap()["path"], "/a");
        assert!(spec.schema("b").is_none());
    }
}
