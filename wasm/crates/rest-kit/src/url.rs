//! The parts of the WHATWG URL standard the REST layer uses, for http and https URLs only: parsing and
//! serializing (`new URL(text).href`), the origin, `URLSearchParams` (application/x-www-form-urlencoded) and
//! `encodeURIComponent` / `decodeURIComponent`. Output matches Node.js for ASCII hosts; hosts with non-ASCII
//! characters (IDNA) are refused.

/// A parsed http(s) URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    pub scheme: String,
    pub username: String,
    pub password: String,
    pub host: String,
    /// Empty for the scheme's default port.
    pub port: String,
    pub path: String,
    pub query: Option<String>,
    pub fragment: Option<String>,
}

impl Url {
    /// `new URL(text)`; `None` where JavaScript would throw, or for a scheme other than http(s).
    pub fn parse(text: &str) -> Option<Url> {
        let cleaned = clean_input(text);
        let colon = cleaned.find(':')?;
        let scheme = cleaned[..colon].to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return None;
        }
        let rest = cleaned[colon + 1..].trim_start_matches(['/', '\\']);
        let authority_end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
        let (authority, remainder) = rest.split_at(authority_end);
        let (userinfo, host_port) = match authority.rfind('@') {
            Some(at) => (&authority[..at], &authority[at + 1..]),
            None => ("", authority),
        };
        let (username, password) = userinfo.split_once(':').unwrap_or((userinfo, ""));
        let (host, port) = parse_host_port(host_port, &scheme)?;
        let mut url = Url {
            scheme,
            username: encode_set(username, is_userinfo_reserved),
            password: encode_set(password, is_userinfo_reserved),
            host,
            port,
            path: "/".into(),
            query: None,
            fragment: None,
        };
        url.set_path_query_fragment(remainder);
        Some(url)
    }

    /// `new URL(path, origin)` for a path starting with "/" (path, query and fragment from `path`).
    pub fn with_path(&self, path: &str) -> Url {
        let mut url = Url { path: "/".into(), query: None, fragment: None, ..self.clone() };
        url.set_path_query_fragment(&clean_input(path));
        url
    }

    fn set_path_query_fragment(&mut self, remainder: &str) {
        let (before_fragment, fragment) = match remainder.find('#') {
            Some(hash) => (&remainder[..hash], Some(&remainder[hash + 1..])),
            None => (remainder, None),
        };
        let (path, query) = match before_fragment.find('?') {
            Some(question) => (&before_fragment[..question], Some(&before_fragment[question + 1..])),
            None => (before_fragment, None),
        };
        self.path = normalize_path(path);
        self.query = query.map(|query| encode_set(query, is_query_reserved));
        self.fragment = fragment.map(|fragment| encode_set(fragment, is_fragment_reserved));
    }

    /// `url.origin`, e.g. `https://api.example.com:8443`.
    pub fn origin(&self) -> String {
        if self.port.is_empty() {
            format!("{}://{}", self.scheme, self.host)
        } else {
            format!("{}://{}:{}", self.scheme, self.host, self.port)
        }
    }

    /// `url.href`.
    pub fn href(&self) -> String {
        let mut text = format!("{}://", self.scheme);
        if !self.username.is_empty() || !self.password.is_empty() {
            text.push_str(&self.username);
            if !self.password.is_empty() {
                text.push(':');
                text.push_str(&self.password);
            }
            text.push('@');
        }
        text.push_str(&self.host);
        if !self.port.is_empty() {
            text.push(':');
            text.push_str(&self.port);
        }
        text.push_str(&self.path);
        if let Some(query) = &self.query {
            text.push('?');
            text.push_str(query);
        }
        if let Some(fragment) = &self.fragment {
            text.push('#');
            text.push_str(fragment);
        }
        text
    }

    /// `url.searchParams.set(name, value)`: the query is re-serialized as application/x-www-form-urlencoded.
    pub fn set_search_param(&mut self, name: &str, value: &str) {
        let mut pairs = parse_form(self.query.as_deref().unwrap_or(""));
        match pairs.iter().position(|(existing, _)| existing == name) {
            Some(first) => {
                pairs[first].1 = value.to_owned();
                let mut index = 0;
                pairs.retain(|(existing, _)| {
                    index += 1;
                    index - 1 == first || existing != name
                });
            }
            None => pairs.push((name.to_owned(), value.to_owned())),
        }
        self.query = Some(serialize_form(&pairs));
    }

    /// `url.hostname`.
    pub fn hostname(&self) -> &str {
        &self.host
    }
}

// Leading/trailing C0 controls and spaces are stripped, tabs and newlines removed anywhere.
fn clean_input(text: &str) -> String {
    text.trim_matches(|character: char| character <= ' ')
        .chars()
        .filter(|character| !matches!(character, '\t' | '\n' | '\r'))
        .collect()
}

fn parse_host_port(host_port: &str, scheme: &str) -> Option<(String, String)> {
    let (host, port) = if host_port.starts_with('[') {
        let close = host_port.find(']')?;
        let after = &host_port[close + 1..];
        (&host_port[..=close], after.strip_prefix(':').unwrap_or(""))
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) => (host, port),
            None => (host_port, ""),
        }
    };
    let host = decode_percent(host);
    let forbidden = |character: char| " #%/:<>?@[\\]^|".contains(character) || character < ' ';
    let is_ipv6 = host.starts_with('[') && host.ends_with(']');
    if host.is_empty() || !host.is_ascii() || (!is_ipv6 && host.chars().any(forbidden)) {
        return None;
    }
    if !port.bytes().all(|byte| byte.is_ascii_digit()) || port.len() > 5 {
        return None;
    }
    let port = if port.is_empty() {
        String::new()
    } else {
        port.parse::<u32>().ok().filter(|port| *port <= 65535)?.to_string()
    };
    let default_port = if scheme == "https" { "443" } else { "80" };
    let port = if port == default_port { String::new() } else { port };
    Some((host.to_ascii_lowercase(), port))
}

// Path segments: backslashes are slashes, "." and ".." (also percent-encoded) are resolved.
fn normalize_path(path: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    let raw_segments: Vec<&str> = path.split(['/', '\\']).collect();
    let last_index = raw_segments.len().saturating_sub(1);
    for (index, raw_segment) in raw_segments.iter().enumerate() {
        if index == 0 && raw_segment.is_empty() {
            continue;
        }
        let lowered = raw_segment.to_ascii_lowercase();
        let is_last = index == last_index;
        match lowered.as_str() {
            "." | "%2e" => {
                if is_last {
                    segments.push(String::new());
                }
            }
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                segments.pop();
                if is_last {
                    segments.push(String::new());
                }
            }
            _ => segments.push(encode_set(raw_segment, is_path_reserved)),
        }
    }
    format!("/{}", segments.join("/"))
}

fn is_c0_or_non_ascii(byte: u8) -> bool {
    !(0x20..=0x7e).contains(&byte)
}

fn is_fragment_reserved(byte: u8) -> bool {
    is_c0_or_non_ascii(byte) || matches!(byte, b' ' | b'"' | b'<' | b'>' | b'`')
}

fn is_query_reserved(byte: u8) -> bool {
    is_c0_or_non_ascii(byte) || matches!(byte, b' ' | b'"' | b'#' | b'<' | b'>' | b'\'')
}

fn is_path_reserved(byte: u8) -> bool {
    is_c0_or_non_ascii(byte) || matches!(byte, b' ' | b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}')
}

fn is_userinfo_reserved(byte: u8) -> bool {
    is_path_reserved(byte) || matches!(byte, b'/' | b':' | b';' | b'=' | b'@' | b'[' | b'\\' | b']' | b'^' | b'|')
}

fn encode_set(text: &str, is_reserved: fn(u8) -> bool) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if is_reserved(byte) {
            push_percent(&mut encoded, byte);
        } else {
            encoded.push(byte as char);
        }
    }
    encoded
}

fn push_percent(text: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    text.push('%');
    text.push(HEX[usize::from(byte >> 4)] as char);
    text.push(HEX[usize::from(byte & 0xf)] as char);
}

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            push_percent(&mut encoded, byte);
        }
    }
    encoded
}

/// `decodeURIComponent(text)`; `None` where JavaScript throws (a malformed escape or invalid UTF-8).
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let byte = bytes
                .get(index + 1..index + 3)
                .and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok())?;
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

// Lenient percent-decoding of the form parser and of hosts: bad escapes stay as they are.
fn decode_percent(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let escaped = (bytes[index] == b'%')
            .then(|| bytes.get(index + 1..index + 3))
            .flatten()
            .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))
            .and_then(|hex| u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok());
        match escaped {
            Some(byte) => {
                decoded.push(byte);
                index += 3;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// `new URLSearchParams(query)` as name/value pairs.
pub fn parse_form(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_percent(&name.replace('+', " ")), decode_percent(&value.replace('+', " ")))
        })
        .collect()
}

/// `new URLSearchParams(pairs).toString()`.
pub fn serialize_form(pairs: &[(String, String)]) -> String {
    let mut text = String::new();
    for (index, (name, value)) in pairs.iter().enumerate() {
        if index > 0 {
            text.push('&');
        }
        push_form_component(&mut text, name);
        text.push('=');
        push_form_component(&mut text, value);
    }
    text
}

fn push_form_component(text: &mut String, component: &str) {
    for byte in component.bytes() {
        match byte {
            b' ' => text.push('+'),
            byte if byte.is_ascii_alphanumeric() || b"*-._".contains(&byte) => text.push(byte as char),
            byte => push_percent(text, byte),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_like_node() {
        let href = |text: &str| Url::parse(text).map(|url| url.href());
        assert_eq!(href("HTTPS://ExA.com:443").as_deref(), Some("https://exa.com/"));
        assert_eq!(href("https://h/a/%2e%2E/b/./c/..").as_deref(), Some("https://h/b/"));
        assert_eq!(href("https://h/é?é#é").as_deref(), Some("https://h/%C3%A9?%C3%A9#%C3%A9"));
        assert_eq!(href("https://h/a b'?x='y").as_deref(), Some("https://h/a%20b'?x=%27y"));
        assert_eq!(href("mailto:x@y"), None);
        let mut url = Url::parse("https://h/x?a=1+2&b=%zz&c").unwrap();
        url.set_search_param("k", "v w*~");
        assert_eq!(url.href(), "https://h/x?a=1+2&b=%25zz&c=&k=v+w*%7E");
        assert_eq!(encode_uri_component("a b/é*~!()'"), "a%20b%2F%C3%A9*~!()'");
        assert_eq!(decode_uri_component("%E0%A4%A"), None);
    }
}
