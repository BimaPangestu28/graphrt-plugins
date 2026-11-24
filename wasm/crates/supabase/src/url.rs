//! Request URLs on the project origin (port of the shared client's `buildUrl` and
//! `resolveRelativePath`, with the WHATWG URL parser's percent-encoding) and the
//! `api_request` tool's path policy (port of `normalizeApiPath`, `guardToolApiRequest`
//! and `parseExtraPaths`).

use graphrt_wasm_guest::{PluginError, Value};

use crate::js;

const MAX_DOT_DECODE_ROUNDS: usize = 4;
const MAX_POLICY_DECODE_ROUNDS: usize = 5;
pub const EXTRA_PATHS_ENV: &str = "SUPABASE_TOOL_API_EXTRA_PATHS";
const POLICY_REASON: &str = "agent tools may only read the Data API (/rest/v1) and Storage; auth admin, edge functions and other services are node only";

/// `origin + path` as `new URL(path, origin).toString()` gives it, after refusing paths that
/// could leave the API (`//host`, backslashes, dot segments, also percent-encoded).
pub fn resolve(origin: &str, path: &str) -> Result<String, PluginError> {
    if !is_safe_relative_path(path) {
        return Err(PluginError::invalid_input(format!(
            "Unsafe API path {}: use \"/segment/...\" without \"//\", \"\\\" or dot segments",
            js::json_text(&Value::String(path.to_owned()))
        )));
    }
    Ok(format!("{origin}{}", normalize_url_tail(path)))
}

fn is_safe_relative_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains('\\')
        && !has_dot_segment(path)
}

// The URL parser turns "%2e%2e" into "..", and some servers decode twice.
fn has_dot_segment(path: &str) -> bool {
    let pathname = path.split(['?', '#']).next().unwrap_or_default();
    pathname.split('/').any(|segment| {
        let mut decoded = segment.to_owned();
        for _ in 0..MAX_DOT_DECODE_ROUNDS {
            if decoded.split('\\').any(|part| part == "." || part == "..") {
                return true;
            }
            match js::decode_uri_component(&decoded) {
                Some(next) if next != decoded => decoded = next,
                _ => return false,
            }
        }
        true
    })
}

/// Path, query and fragment of a path-absolute URL string as the WHATWG parser writes them.
fn normalize_url_tail(path: &str) -> String {
    let cleaned: String = path
        .trim_end_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let (before_fragment, fragment) = match cleaned.split_once('#') {
        Some((head, fragment)) => (head, Some(fragment)),
        None => (cleaned.as_str(), None),
    };
    let (pathname, query) = match before_fragment.split_once('?') {
        Some((pathname, query)) => (pathname, Some(query)),
        None => (before_fragment, None),
    };
    let is_c0_or_non_ascii = |b: u8| !(0x20..=0x7e).contains(&b);
    let mut out = js::percent_encode(pathname, |b| {
        !is_c0_or_non_ascii(b) && !b" \"<>`{}".contains(&b)
    });
    if let Some(query) = query {
        out.push('?');
        out.push_str(&js::percent_encode(query, |b| {
            !is_c0_or_non_ascii(b) && !b" \"'<>".contains(&b)
        }));
    }
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(&js::percent_encode(fragment, |b| {
            !is_c0_or_non_ascii(b) && !b" \"<>`".contains(&b)
        }));
    }
    out
}

/// `url.searchParams.set(name, value)` for each pair: the query is re-serialised as
/// `application/x-www-form-urlencoded`, like JavaScript does once it is changed.
pub fn set_query_values(url: &str, values: &[(String, String)]) -> String {
    if values.is_empty() {
        return url.to_owned();
    }
    let (before_fragment, fragment) = match url.split_once('#') {
        Some((head, fragment)) => (head, Some(fragment)),
        None => (url, None),
    };
    let (base, query) = before_fragment
        .split_once('?')
        .unwrap_or((before_fragment, ""));
    let mut pairs = js::form_urldecode(query);
    for (name, value) in values {
        match pairs.iter().position(|(existing, _)| existing == name) {
            Some(first) => {
                pairs[first].1 = value.clone();
                let mut index = 0;
                pairs.retain(|(existing, _)| {
                    index += 1;
                    index - 1 == first || existing != name
                });
            }
            None => pairs.push((name.clone(), value.clone())),
        }
    }
    let serialized = js::form_urlencode(&pairs);
    let mut out = base.to_owned();
    if !serialized.is_empty() {
        out.push('?');
        out.push_str(&serialized);
    }
    if let Some(fragment) = fragment {
        out.push('#');
        out.push_str(fragment);
    }
    out
}

// --- api_request path policy ---------------------------------------------------------------------

/// Refuse an `api_request` tool path outside /rest/v1 and Storage (plus SUPABASE_TOOL_API_EXTRA_PATHS).
pub fn assert_tool_path_allowed(raw_path: &str, extra_paths: &str) -> Result<(), PluginError> {
    let normalized = normalize_api_path(raw_path);
    let allowed = is_builtin_allowed(&normalized)
        || parse_extra_paths(extra_paths)
            .iter()
            .any(|pattern| glob_matches(pattern, &normalized));
    if allowed {
        return Ok(());
    }
    Err(PluginError::new(
        "permission_denied",
        format!("api_request cannot reach {normalized} as an agent tool: {POLICY_REASON}"),
    ))
}

/// `^\/rest\/v1(\/.*)?$`, `^\/storage\/v1\/bucket(\/[^/]+)?$` and `^\/storage\/v1\/object\/.+$`.
fn is_builtin_allowed(path: &str) -> bool {
    let rest = path == "/rest/v1" || path.starts_with("/rest/v1/");
    let bucket = path == "/storage/v1/bucket"
        || path
            .strip_prefix("/storage/v1/bucket/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/'));
    let object = path
        .strip_prefix("/storage/v1/object/")
        .is_some_and(|tail| !tail.is_empty());
    rest || bucket || object
}

/// Query dropped, segments decoded until stable, backslashes as slashes, `.`/`..` resolved, lowercased.
pub fn normalize_api_path(raw_path: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    let pathname = raw_path.split(['?', '#']).next().unwrap_or_default();
    for raw_segment in pathname.split(['/', '\\']) {
        for part in decode_repeatedly(raw_segment).split(['/', '\\']) {
            // ASCII case: a non-ASCII letter that JavaScript would map to ASCII (the Kelvin sign) stays,
            // so such a path matches no allowed pattern and is refused, never allowed.
            match part.trim().to_ascii_lowercase().as_str() {
                "" | "." => {}
                ".." => {
                    segments.pop();
                }
                segment => segments.push(segment.to_owned()),
            }
        }
    }
    format!("/{}", segments.join("/"))
}

fn decode_repeatedly(text: &str) -> String {
    let mut decoded = text.to_owned();
    for _ in 0..MAX_POLICY_DECODE_ROUNDS {
        match js::decode_uri_component(&decoded) {
            Some(next) if next != decoded => decoded = next,
            _ => break,
        }
    }
    decoded
}

/// SUPABASE_TOOL_API_EXTRA_PATHS: comma-separated paths, normalised, `*` stands for one segment.
/// Each pattern is its literal parts; a wildcard sits between two parts.
fn parse_extra_paths(raw: &str) -> Vec<Vec<String>> {
    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            normalize_api_path(&entry.replace('*', "\u{0}"))
                .split('\u{0}')
                .map(str::to_owned)
                .collect()
        })
        .collect()
}

/// Whether `path` is the parts in order with one or more non-`/` characters for each wildcard.
fn glob_matches(parts: &[String], path: &str) -> bool {
    let Some((first, rest)) = parts.split_first() else {
        return path.is_empty();
    };
    let Some(tail) = path.strip_prefix(first.as_str()) else {
        return false;
    };
    if rest.is_empty() {
        return tail.is_empty();
    }
    let segment_end = tail.find('/').unwrap_or(tail.len());
    (1..=segment_end)
        .any(|taken| tail.is_char_boundary(taken) && glob_matches(rest, &tail[taken..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_encoded_like_the_whatwg_parser() {
        let url = resolve("https://a.supabase.co", "/rest/v1/x y?a=b c'#f`").unwrap();
        assert_eq!(url, "https://a.supabase.co/rest/v1/x%20y?a=b%20c%27#f%60");
        assert!(resolve("https://a.supabase.co", "/rest/v1/%252e%252e/auth").is_err());
        assert!(resolve("https://a.supabase.co", "//evil.test/x").is_err());
    }

    #[test]
    fn setting_query_values_reserialises_the_query() {
        let url = set_query_values(
            "https://a/x?select=id,b&id=eq.1&id=2",
            &[("id".into(), "eq.3".into())],
        );
        assert_eq!(url, "https://a/x?select=id%2Cb&id=eq.3");
    }

    #[test]
    fn tool_paths_follow_the_policy() {
        assert!(assert_tool_path_allowed("/rest/v1/orders?select=id", "").is_ok());
        assert!(assert_tool_path_allowed("/storage/v1/bucket/avatars", "").is_ok());
        let refused = assert_tool_path_allowed("/rest/v1/../auth/v1/admin/users", "").unwrap_err();
        assert!(
            refused.message.contains("/auth/v1/admin/users"),
            "{}",
            refused.message
        );
        assert!(assert_tool_path_allowed("/functions/v1/hello", "/functions/v1/*").is_ok());
        assert!(assert_tool_path_allowed("/functions/v1/hello/x", "/functions/v1/*").is_err());
    }
}
