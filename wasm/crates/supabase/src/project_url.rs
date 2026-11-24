//! `SUPABASE_URL` (port of `resolveProjectUrl` and the shared `checkBaseUrl`).

use graphrt_wasm_guest::PluginError;

pub const URL_ENV: &str = "SUPABASE_URL";
const LOCAL_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]"];

/// The project origin, e.g. `https://abcdefghijklmnopqrst.supabase.co`.
pub fn resolve(raw: &str) -> Result<String, PluginError> {
    origin_of(raw.trim()).map_err(|problem| {
        PluginError::invalid_input(format!("Invalid API base URL configuration: {problem}"))
    })
}

fn origin_of(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err(format!(
            "set {URL_ENV} to your project URL, e.g. https://<project-ref>.supabase.co"
        ));
    }
    let (scheme, rest) = raw.split_once("://").ok_or("Invalid URL")?;
    let scheme = scheme.to_ascii_lowercase();
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    if !tail.trim_start_matches('/').is_empty() {
        return Err(format!(
            "{URL_ENV} must be the project origin only (no path such as /rest/v1, no query)"
        ));
    }
    // An origin never carries credentials.
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .to_ascii_lowercase();
    let (host, port) = split_port(&host_port);
    if host.is_empty() || !matches!(scheme.as_str(), "http" | "https") {
        return Err("Invalid URL".into());
    }
    if host.ends_with(".supabase.co") && !is_project_host(host) {
        return Err(format!(
            "{URL_ENV} must be https://<project-ref>.supabase.co or your custom domain"
        ));
    }
    let origin = match port.filter(|p| !is_default_port(&scheme, p)) {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    };
    if scheme != "https" && !LOCAL_HOSTS.contains(&host) {
        return Err(format!(
            "`baseUrl` {origin} must use https (http only on localhost)"
        ));
    }
    Ok(origin)
}

fn split_port(host_port: &str) -> (&str, Option<&str>) {
    match host_port.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') && port.bytes().all(|b| b.is_ascii_digit()) => {
            (host, (!port.is_empty()).then_some(port))
        }
        _ => (host_port, None),
    }
}

fn is_default_port(scheme: &str, port: &str) -> bool {
    (scheme == "https" && port == "443") || (scheme == "http" && port == "80")
}

/// `^[a-z0-9-]+\.supabase\.co$`
fn is_project_host(host: &str) -> bool {
    let reference = &host[..host.len() - ".supabase.co".len()];
    !reference.is_empty()
        && reference
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
