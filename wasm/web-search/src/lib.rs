//! WebAssembly build of the web-search plugin. The three providers (Tavily, Brave Search, SerpAPI) are declarative
//! APIs in spec.json (exported from web-search/lib/search-providers.mjs); `search` and `search_news` are hooks, like
//! the hand-written operations of web-search/definition.mjs: WEB_SEARCH_PROVIDER picks the provider, the neutral
//! arguments become the provider's, and its response becomes
//! `{provider, query, answer, results: [{title, url, snippet, published_at, source}]}`.

use rest_kit::url::Url;
use rest_kit::{js, json, Hooks, Kit, Map, OperationResult, RestError, Value};

const PROVIDER_ENV: &str = "WEB_SEARCH_PROVIDER";
const MAX_RESULTS: f64 = 20.0;
const PROVIDERS: [&str; 3] = ["tavily", "brave", "serpapi"];

/// `search` and `search_news`.
pub struct WebSearch;

impl Hooks for WebSearch {
    fn call(&self, kit: &Kit, name: &str, raw_arguments: &Value) -> Option<Result<OperationResult, RestError>> {
        let kind = match name {
            "search" => SearchKind::Web,
            "search_news" => SearchKind::News,
            _ => return None,
        };
        Some(search(kit, name, kind, raw_arguments))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SearchKind {
    Web,
    News,
}

/// `selectProvider`: the trimmed, lower-cased WEB_SEARCH_PROVIDER.
fn select_provider(kit: &Kit) -> Result<&'static str, RestError> {
    let provider_name =
        kit.env(PROVIDER_ENV).map(|value| js::trim(value).to_ascii_lowercase()).filter(|name| !name.is_empty());
    if let Some(provider) = PROVIDERS.iter().find(|provider| Some(**provider) == provider_name.as_deref()) {
        return Ok(provider);
    }
    let got = provider_name.map(|name| format!(" (got {})", js::json_string(&name))).unwrap_or_default();
    Err(RestError::invalid_input(format!("Set {PROVIDER_ENV} to one of {}{got}", PROVIDERS.join(", "))))
}

// The runner's order: validate the neutral arguments, then the provider (inside resolveAccessToken) and its key.
fn search(kit: &Kit, name: &str, kind: SearchKind, raw_arguments: &Value) -> Result<OperationResult, RestError> {
    let args = kit.validate(name, raw_arguments)?;
    let provider = select_provider(kit)?;
    let client = kit.client(provider, raw_arguments)?;
    let operation = operation_for(provider, kind);
    let provider_limit = if provider == "serpapi" { 10.0 } else { MAX_RESULTS };
    let max_results = args.get("max_results").map_or(f64::NAN, js::to_number).min(provider_limit);
    let provider_args =
        kit.validate_for(provider, operation, &Value::Object(build_args(provider, kind, &args, max_results)))?;
    let body = kit.run_rest_operation(&client, operation, provider_args)?.data;
    let (answer, results) = normalize(provider, &body, kind)?;
    let kept: Vec<Value> = results.into_iter().take(max_results.max(0.0) as usize).collect();
    let query = args.get("query").cloned().unwrap_or(Value::Null);
    Ok(OperationResult::data(json!({"provider": provider, "query": query, "answer": answer, "results": kept})))
}

fn operation_for(provider: &str, kind: SearchKind) -> &'static str {
    match (provider, kind) {
        ("tavily", _) => "tavily_search",
        ("brave", SearchKind::News) => "brave_news_search",
        ("brave", SearchKind::Web) => "brave_web_search",
        _ => "serpapi_google_search",
    }
}

fn freshness(provider: &str, value: Option<&Value>) -> Option<Value> {
    let index =
        ["day", "week", "month", "year"].iter().position(|period| value.and_then(Value::as_str) == Some(*period))?;
    let mapped = match provider {
        "brave" => ["pd", "pw", "pm", "py"][index],
        _ => ["qdr:d", "qdr:w", "qdr:m", "qdr:y"][index],
    };
    Some(Value::String(mapped.into()))
}

// `buildArgs` of each provider adapter, with undefined values left out (`stripUndefined`).
fn build_args(provider: &str, kind: SearchKind, args: &Map<String, Value>, max_results: f64) -> Map<String, Value> {
    let text = |name: &str, upper: bool| {
        args.get(name).filter(|value| !value.is_null()).map(|value| {
            let text = js::to_text(value);
            Value::String(if upper { text.to_ascii_uppercase() } else { text.to_ascii_lowercase() })
        })
    };
    let entries: Vec<(&str, Option<Value>)> = match provider {
        "tavily" => vec![
            ("query", args.get("query").cloned()),
            ("topic", Some(Value::String(if kind == SearchKind::News { "news" } else { "general" }.into()))),
            ("max_results", Some(js::number_value(max_results))),
            ("time_range", args.get("freshness").cloned()),
            ("include_answer", args.get("include_answer").cloned()),
        ],
        "brave" => vec![
            ("q", args.get("query").cloned()),
            ("count", Some(js::number_value(max_results))),
            ("country", text("country", true)),
            ("search_lang", text("language", false)),
            ("freshness", freshness(provider, args.get("freshness"))),
        ],
        _ => vec![
            ("q", args.get("query").cloned()),
            ("gl", text("country", false)),
            ("hl", text("language", false)),
            ("tbm", (kind == SearchKind::News).then(|| Value::String("nws".into()))),
            ("tbs", freshness(provider, args.get("freshness"))),
        ],
    };
    entries.into_iter().filter_map(|(name, value)| value.map(|value| (name.to_owned(), value))).collect()
}

fn hostname_of(url: Option<&Value>) -> Value {
    let parsed = url.filter(|url| !url.is_null()).and_then(|url| Url::parse(&js::to_text(url)));
    parsed.map_or(Value::Null, |url| Value::String(url.hostname().to_owned()))
}

fn or_null(value: Option<&Value>) -> Value {
    value.filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null)
}

// `buildResult`: missing fields are null, the source defaults to the URL's host.
fn build_result(
    title: Option<&Value>,
    url: Option<&Value>,
    snippet: Option<&Value>,
    published_at: Option<&Value>,
    source: Option<&Value>,
) -> Value {
    let source = match source.filter(|source| !source.is_null()) {
        Some(source) => source.clone(),
        None => hostname_of(url),
    };
    json!({"title": or_null(title), "url": or_null(url), "snippet": or_null(snippet), "published_at": or_null(published_at), "source": source})
}

fn items<'a>(body: &'a Value, path: &[&str]) -> Vec<&'a Value> {
    let found = path.iter().try_fold(body, |current, key| current.get(*key).filter(|value| !value.is_null()));
    found.and_then(Value::as_array).map(|items| items.iter().collect()).unwrap_or_default()
}

fn normalize(provider: &str, body: &Value, kind: SearchKind) -> Result<(Value, Vec<Value>), RestError> {
    match provider {
        "tavily" => {
            let results = items(body, &["results"])
                .into_iter()
                .map(|item| {
                    build_result(
                        item.get("title"),
                        item.get("url"),
                        item.get("content"),
                        item.get("published_date"),
                        None,
                    )
                })
                .collect();
            Ok((or_null(body.get("answer")), results))
        }
        "brave" => {
            let path: &[&str] = if kind == SearchKind::News { &["results"] } else { &["web", "results"] };
            let results = items(body, path)
                .into_iter()
                .map(|item| {
                    let published_at = item.get("page_age").filter(|age| !age.is_null()).or_else(|| item.get("age"));
                    build_result(
                        item.get("title"),
                        item.get("url"),
                        item.get("description"),
                        published_at,
                        item.get("meta_url").and_then(|meta| meta.get("hostname")),
                    )
                })
                .collect();
            Ok((Value::Null, results))
        }
        _ => normalize_serpapi(body, kind),
    }
}

fn normalize_serpapi(body: &Value, kind: SearchKind) -> Result<(Value, Vec<Value>), RestError> {
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        let lowered = error.to_ascii_lowercase();
        if !lowered.contains("hasn't returned any results") {
            // Not retryable: a quota only refills with the next hour or billing period.
            let quota_markers =
                ["run out of searches", "searches for the month are exhausted", "throughput limit", "plan limit"];
            let kind =
                if quota_markers.iter().any(|marker| lowered.contains(marker)) { "rate_limited" } else { "api_error" };
            return Err(RestError::new(kind, format!("SerpAPI error: {error}")));
        }
    }
    let path = if kind == SearchKind::News { "news_results" } else { "organic_results" };
    let results = items(body, &[path])
        .into_iter()
        .map(|item| {
            let source = match item.get("source") {
                Some(Value::Object(source)) => source.get("name").cloned(),
                Some(Value::Array(_)) => None,
                other => other.cloned(),
            };
            build_result(item.get("title"), item.get("link"), item.get("snippet"), item.get("date"), source.as_ref())
        })
        .collect();
    Ok((Value::Null, results))
}

pub const MANIFEST: &str = include_str!("../manifest.json");
pub const SPEC: &str = include_str!("../spec.json");

rest_kit::export_rest_plugin!(MANIFEST, SPEC, WebSearch);
