//! The `file` input of `upload_object` (port of `readFileInput` and `fetchPublicHttpsBytes`):
//! an https URL on a public host, downloaded through the host with redirects followed by hand
//! (each hop checked), as base64 so any bytes pass. A module has no file system, so local paths
//! (SUPABASE_UPLOAD_DIR in the Node.js plugin) are refused.

use std::net::{Ipv4Addr, Ipv6Addr};

use graphrt_wasm_guest::{http, HttpRequest, HttpResponse, PluginError};

const LABEL: &str = "file";
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
/// What the Node.js plugin's transfer budget leaves the download: the host timeout (130 s) minus
/// 10 s, minus the 110 s the upload request needs.
const DOWNLOAD_TIMEOUT_MS: u64 = 10_000;
/// The upload request's own timeout; the host caps it (30 s by default).
pub const UPLOAD_TIMEOUT_MS: u64 = 110_000;
const REDIRECT_STATUSES: &[u16] = &[301, 302, 303, 307, 308];

/// A downloaded file.
#[derive(Debug)]
pub struct FileInput {
    pub base64: String,
    /// The download's media type without parameters, lower-case; `""` when it has none.
    pub content_type: String,
}

/// Read the `file` argument.
pub fn read_file_input(reference: &str) -> Result<FileInput, PluginError> {
    if reference
        .get(..8)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
    {
        return download(reference);
    }
    if has_scheme(reference) {
        return Err(invalid(format!(
            "`{LABEL}` must be an https URL or an absolute local path"
        )));
    }
    Err(invalid(format!(
        "`{LABEL}` is a local path, but the WebAssembly build has no file system; pass an https URL (or use the Node.js plugin with SUPABASE_UPLOAD_DIR)"
    )))
}

/// `^[a-z][a-z0-9+.-]*:`
fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once(':') else {
        return false;
    };
    let mut bytes = scheme.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
}

fn download(original: &str) -> Result<FileInput, PluginError> {
    let mut current = original.to_owned();
    for _ in 0..=MAX_REDIRECTS {
        let hop = if current == original {
            String::new()
        } else {
            format!(" (redirected to {current})")
        };
        assert_public_https(&current, original, &hop)?;
        let response = fetch(&current, original, &hop)?;
        if !REDIRECT_STATUSES.contains(&response.status) {
            return downloaded(response, original);
        }
        let Some(location) = response.headers.get("location") else {
            return Err(invalid(format!(
                "`{LABEL}` {original} answered HTTP {} without a Location",
                response.status
            )));
        };
        current = join_url(&current, location);
    }
    Err(invalid(format!(
        "`{LABEL}` {original} redirected more than {MAX_REDIRECTS} times"
    )))
}

fn fetch(url: &str, original: &str, hop: &str) -> Result<HttpResponse, PluginError> {
    let request = HttpRequest {
        method: "GET".into(),
        url: url.into(),
        timeout_ms: Some(DOWNLOAD_TIMEOUT_MS),
        response_encoding: Some("base64".into()),
        ..HttpRequest::default()
    };
    http(&request).map_err(|error| match error.kind.as_str() {
        "timeout" => network_error("download timed out"),
        "egress_denied" => refuse_host(original, hop),
        "too_large" => invalid(format!(
            "`{LABEL}` is larger than this host lets a WebAssembly plugin download: {}",
            error.message
        )),
        // A host without binary bodies (graphrt 0.6) refuses `response_encoding`.
        "invalid_request" if error.message.contains("response_encoding") => invalid(format!(
            "upload_object needs a graphrt host with binary HTTP bodies (the graphrt release after 0.6.1): {}",
            error.message
        )),
        _ => network_error(&error.message),
    })
}

fn downloaded(response: HttpResponse, url: &str) -> Result<FileInput, PluginError> {
    if !(200..300).contains(&response.status) {
        return Err(PluginError::new(
            "api_error",
            format!(
                "Could not download `{LABEL}` {url}: HTTP {}",
                response.status
            ),
        ));
    }
    let declared_length = response
        .headers
        .get("content-length")
        .and_then(|length| length.trim().parse::<u64>().ok());
    let base64 = response.body_base64.unwrap_or_default();
    let padding = base64.bytes().rev().take_while(|b| *b == b'=').count() as u64;
    let decoded_length = (base64.len() as u64 / 4 * 3).saturating_sub(padding);
    if declared_length.unwrap_or(0) > MAX_FILE_BYTES || decoded_length > MAX_FILE_BYTES {
        return Err(invalid(format!(
            "`{LABEL}` is larger than the {MAX_FILE_BYTES} bytes limit"
        )));
    }
    let content_type = response
        .headers
        .get("content-type")
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    Ok(FileInput {
        base64,
        content_type,
    })
}

/// https on a host that is not loopback, private or link-local (literal addresses; the host's
/// egress checks resolved ones).
fn assert_public_https(candidate: &str, original: &str, hop: &str) -> Result<(), PluginError> {
    let Some((scheme, rest)) = candidate.split_once("://") else {
        return Err(invalid(format!("`{LABEL}` is not a valid URL")));
    };
    if !scheme.eq_ignore_ascii_case("https") {
        return Err(invalid(format!(
            "`{LABEL}` must be an https URL and stay on https{hop}"
        )));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .to_ascii_lowercase();
    let host = match host_port.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next().unwrap_or_default().to_owned(),
        None => host_port.split(':').next().unwrap_or_default().to_owned(),
    };
    if host.is_empty() {
        return Err(invalid(format!("`{LABEL}` is not a valid URL")));
    }
    if host == "localhost" || host.ends_with(".localhost") || is_internal_address(&host) {
        return Err(refuse_host(original, hop));
    }
    Ok(())
}

fn is_internal_address(host: &str) -> bool {
    if let Ok(v4) = host.parse::<Ipv4Addr>() {
        return is_internal_v4(v4);
    }
    let Ok(v6) = host.parse::<Ipv6Addr>() else {
        return false;
    };
    let s = v6.segments();
    let mapped_or_nat64 =
        (s[..5] == [0; 5] && s[5] == 0xffff) || (s[..6] == [0x64, 0xff9b, 0, 0, 0, 0]);
    s[..7] == [0; 7] && s[7] <= 1
        || mapped_or_nat64
        || (s[0] & 0xfe00) == 0xfc00
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] & 0xff00) == 0xff00
}

fn is_internal_v4(address: Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();
    matches!(a, 0 | 10 | 127 | 224..=255)
        || (a == 100 && (64..128).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 0 && address.octets()[2] == 0)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
}

/// `new URL(location, base).href` for the forms servers send.
fn join_url(base: &str, location: &str) -> String {
    if has_scheme(location) {
        return location.to_owned();
    }
    let (scheme, rest) = base.split_once("://").unwrap_or(("https", base));
    if let Some(network_path) = location.strip_prefix("//") {
        return format!("{scheme}://{network_path}");
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let origin = format!("{scheme}://{}", &rest[..authority_end]);
    if location.starts_with('/') {
        return format!("{origin}{location}");
    }
    let path = rest[authority_end..]
        .split(['?', '#'])
        .next()
        .unwrap_or_default();
    let directory = path.rfind('/').map_or("/", |end| &path[..=end]);
    format!("{origin}{directory}{location}")
}

fn refuse_host(original: &str, hop: &str) -> PluginError {
    invalid(format!(
        "`{LABEL}` {original} points to a loopback, private or link-local host{hop}; only public hosts are allowed"
    ))
}

fn network_error(reason: &str) -> PluginError {
    PluginError::new("network_error", format!("Network error: {reason}")).retryable()
}

fn invalid(message: String) -> PluginError {
    PluginError::invalid_input(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_internal_and_non_https_sources() {
        assert!(assert_public_https("https://127.0.0.1/a", "u", "").is_err());
        assert!(assert_public_https("https://[::ffff:10.0.0.1]/a", "u", "").is_err());
        assert!(assert_public_https("https://files.localhost/a", "u", "").is_err());
        assert!(assert_public_https("http://example.com/a", "u", "").is_err());
        assert!(assert_public_https("https://example.com/a", "u", "").is_ok());
        assert!(read_file_input("/etc/passwd")
            .unwrap_err()
            .message
            .contains("no file system"));
        assert!(read_file_input("file:///etc/passwd")
            .unwrap_err()
            .message
            .contains("https URL"));
    }

    #[test]
    fn follows_relative_locations() {
        assert_eq!(
            join_url("https://a.test/x/y.png?q", "z.png"),
            "https://a.test/x/z.png"
        );
        assert_eq!(join_url("https://a.test/x/y.png", "/z"), "https://a.test/z");
        assert_eq!(
            join_url("https://a.test/x", "//b.test/z"),
            "https://b.test/z"
        );
    }
}
