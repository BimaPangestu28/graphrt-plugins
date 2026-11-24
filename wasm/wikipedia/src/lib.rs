//! WebAssembly build of the wikipedia plugin, with the two wrappers of wikipedia/lib/wikipedia-wrappers.mjs:
//!   - `language` on every operation but `api_request` sends the call to that language's wiki, and
//!     WIKIPEDIA_LANGUAGE sets the default (the base URL hook);
//!   - `get_page_content` caps the plain text at `max_chars` and turns a missing page into not_found.

use rest_kit::{js, Hooks, Kit, OperationResult, RestError, Value};

const LANGUAGE_ENV: &str = "WIKIPEDIA_LANGUAGE";
const DEFAULT_LANGUAGE: &str = "en";
const DEFAULT_MAX_CHARS: u64 = 20_000;

/// The language and page-content wrappers.
pub struct Wikipedia;

impl Hooks for Wikipedia {
    fn base_url(&self, kit: &Kit, _api: &str) -> Result<String, RestError> {
        let language =
            kit.env(LANGUAGE_ENV).map(js::trim).filter(|language| !language.is_empty()).unwrap_or(DEFAULT_LANGUAGE);
        build_wikipedia_url(&Value::String(language.into()))
    }

    fn call(&self, kit: &Kit, name: &str, raw_arguments: &Value) -> Option<Result<OperationResult, RestError>> {
        (name != "api_request").then(|| run_in_language(kit, name, raw_arguments))
    }
}

/// `buildWikipediaUrl`: only plain wiki codes ("en", "zh-yue", "be-tarask"), so the host stays on wikipedia.org.
fn build_wikipedia_url(language: &Value) -> Result<String, RestError> {
    match language.as_str().filter(|code| is_wiki_code(code)) {
        Some(code) => Ok(format!("https://{code}.wikipedia.org")),
        None => Err(RestError::invalid_input(format!(
            "Invalid Wikipedia language {}: use a wiki code such as en, id or zh-yue",
            js::stringify(language)
        ))),
    }
}

// `/^[a-z]{2,12}(-[a-z]{1,12}){0,3}$/`.
fn is_wiki_code(code: &str) -> bool {
    let mut parts = code.split('-');
    let is_letters = |part: &str, minimum: usize| {
        (minimum..=12).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_lowercase())
    };
    let first_ok = parts.next().is_some_and(|first| is_letters(first, 2));
    let rest: Vec<&str> = parts.collect();
    first_ok && rest.len() <= 3 && rest.iter().all(|part| is_letters(part, 1))
}

fn run_in_language(kit: &Kit, name: &str, raw_arguments: &Value) -> Result<OperationResult, RestError> {
    let mut args = kit.validate(name, raw_arguments)?;
    let mut client = kit.client("main", raw_arguments)?;
    let max_chars = args.remove("max_chars");
    if let Some(language) = args.remove("language") {
        client.base_url = build_wikipedia_url(&language)?;
    }
    if name != "get_page_content" {
        return kit.run_rest_operation(&client, name, args);
    }
    // MediaWiki treats any value of a boolean parameter as true, including "false", so false is not sent.
    if args.get("intro_only") == Some(&Value::Bool(false)) {
        args.remove("intro_only");
    }
    let requested_title = args.get("page_title").cloned().unwrap_or(Value::Null);
    let result = kit.run_rest_operation(&client, name, args)?;
    let max_chars = max_chars.and_then(|max| max.as_u64()).unwrap_or(DEFAULT_MAX_CHARS) as usize;
    Ok(OperationResult { data: truncate_extract(result.data, max_chars, &requested_title)?, ..result })
}

fn truncate_extract(page: Value, max_chars: usize, requested_title: &Value) -> Result<Value, RestError> {
    let is_missing = js::is_truthy(page.get("missing")) || js::is_truthy(page.get("invalid"));
    let Some(Value::String(extract)) = page.get("extract").filter(|_| !is_missing && js::is_truthy(Some(&page))) else {
        let title = page.get("title").filter(|title| !title.is_null()).unwrap_or(requested_title);
        let reason = page
            .get("invalidreason")
            .filter(|reason| js::is_truthy(Some(reason)))
            .map(|reason| format!(": {}", js::to_text(reason)))
            .unwrap_or_default();
        return Err(RestError::new("not_found", format!("Wikipedia has no page {}{reason}", js::stringify(title))));
    };
    let total_chars = js::utf16_len(extract);
    let shortened = js::utf16_prefix(extract, max_chars).to_owned();
    let Value::Object(mut map) = page else { unreachable!("a page with an extract is an object") };
    map.insert("extract".into(), Value::String(shortened));
    map.insert("truncated".into(), Value::Bool(total_chars > max_chars));
    map.insert("total_chars".into(), Value::from(total_chars));
    Ok(Value::Object(map))
}

pub const MANIFEST: &str = include_str!("../manifest.json");
pub const SPEC: &str = include_str!("../spec.json");

rest_kit::export_rest_plugin!(MANIFEST, SPEC, Wikipedia);
