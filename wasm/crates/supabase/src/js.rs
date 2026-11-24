//! The JavaScript behaviour the Node.js plugin relies on, so the WebAssembly build
//! produces the same strings: `Number()`, `String()`, `encodeURIComponent`,
//! `decodeURIComponent` and `URLSearchParams`.

use graphrt_wasm_guest::serde_json::{self, Number};
use graphrt_wasm_guest::Value;

/// `Number(text)`; `None` for `NaN`.
pub fn parse_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if let Some(value) = parse_prefixed_integer(trimmed) {
        return value;
    }
    let (sign, unsigned) = match trimmed.as_bytes()[0] {
        b'-' => (-1.0, &trimmed[1..]),
        b'+' => (1.0, &trimmed[1..]),
        _ => (1.0, trimmed),
    };
    if unsigned == "Infinity" {
        return Some(sign * f64::INFINITY);
    }
    // Rust also reads "inf" and "nan"; JavaScript only reads digits, `.` and an exponent.
    let decimal_chars = unsigned
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'));
    if !decimal_chars
        || !unsigned
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_digit() || b == b'.')
    {
        return None;
    }
    parse_decimal(unsigned).map(|value| sign * value)
}

/// A decimal like `12`, `1.5`, `.5`, `5.` or `1e-3`, read with serde_json's float parser (JSON
/// grammar, so `.5` and `5.` get their missing zero).
fn parse_decimal(text: &str) -> Option<f64> {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], &text[at..]),
        None => (text, ""),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if (whole.is_empty() && fraction.is_empty())
        || !whole
            .bytes()
            .chain(fraction.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let whole = whole.trim_start_matches('0');
    let normalized = format!(
        "{}.{}{exponent}",
        if whole.is_empty() { "0" } else { whole },
        if fraction.is_empty() { "0" } else { fraction }
    );
    serde_json::from_str::<f64>(&normalized).ok()
}

/// `0x`, `0o` and `0b` integers (no sign allowed); `None` when `text` has no such prefix.
fn parse_prefixed_integer(text: &str) -> Option<Option<f64>> {
    let bytes = text.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'0' {
        return None;
    }
    let radix = match bytes[1] {
        b'x' | b'X' => 16,
        b'o' | b'O' => 8,
        b'b' | b'B' => 2,
        _ => return None,
    };
    let digits = &text[2..];
    if digits.is_empty() {
        return Some(None);
    }
    let mut value = 0.0_f64;
    for character in digits.chars() {
        let Some(digit) = character.to_digit(radix) else {
            return Some(None);
        };
        value = value * f64::from(radix) + f64::from(digit);
    }
    Some(Some(value))
}

/// `String(number)`.
pub fn number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        // Exact: a whole f64 below 1e21 fits in an i128.
        #[allow(clippy::cast_possible_truncation)]
        return (value as i128).to_string();
    }
    let (digits, point) = shortest_digits(value.abs());
    let sign = if value < 0.0 { "-" } else { "" };
    format!("{sign}{}", render_js_number(&digits, point))
}

/// The shortest round-trip digits of `value` (no leading or trailing zeros) and the position of the
/// decimal point relative to them, from serde_json's (ryu) output such as `1.5e-7` or `0.001`.
fn shortest_digits(value: f64) -> (String, i32) {
    let text = serde_json::to_string(&value).unwrap_or_default();
    let (mantissa, exponent) = match text.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().unwrap_or(0)),
        None => (text.as_str(), 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let all_digits = format!("{whole}{fraction}");
    let leading_zeros = all_digits.len() - all_digits.trim_start_matches('0').len();
    let digits = all_digits.trim_matches('0').to_owned();
    let point = whole.len() as i32 - leading_zeros as i32 + exponent;
    (digits, point)
}

/// Number::toString for digits `d1...dk` × 10^(point - k).
fn render_js_number(digits: &str, point: i32) -> String {
    let count = digits.len() as i32;
    if count <= point && point <= 21 {
        return format!("{digits}{}", "0".repeat((point - count) as usize));
    }
    if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);
        return format!("{whole}.{fraction}");
    }
    if -6 < point && point <= 0 {
        return format!("0.{}{digits}", "0".repeat((-point) as usize));
    }
    let exponent = point - 1;
    let exponent_sign = if exponent < 0 { "-" } else { "+" };
    let (first, rest) = digits.split_at(1);
    let mantissa = if rest.is_empty() {
        first.to_owned()
    } else {
        format!("{first}.{rest}")
    };
    format!("{mantissa}e{exponent_sign}{}", exponent.abs())
}

/// `String(n)` of a JSON number.
pub fn json_number_string(number: &Number) -> String {
    if number.is_f64() {
        return number_string(number.as_f64().unwrap_or(f64::NAN));
    }
    number.to_string()
}

/// `String(value)` of a JSON value: arrays join their items with `,`, objects are `[object Object]`.
pub fn value_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => json_number_string(number),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    value_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `JSON.stringify(value)` of a value that is present (`undefined` is the caller's case).
pub fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

fn push_percent_encoded(out: &mut String, byte: u8) {
    out.push('%');
    out.push(char::from(HEX[usize::from(byte >> 4)]));
    out.push(char::from(HEX[usize::from(byte & 0x0f)]));
}

/// Percent-encode every byte of `text` for which `keep` is false.
pub fn percent_encode(text: &str, keep: impl Fn(u8) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if keep(byte) {
            out.push(char::from(byte));
        } else {
            push_percent_encoded(&mut out, byte);
        }
    }
    out
}

/// `encodeURIComponent(text)`.
pub fn encode_uri_component(text: &str) -> String {
    percent_encode(text, |b| {
        b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b)
    })
}

/// `decodeURIComponent(text)`; `None` where JavaScript throws (a bad `%` sequence or bytes that are not UTF-8).
pub fn decode_uri_component(text: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut input = text.bytes();
    while let Some(byte) = input.next() {
        if byte != b'%' {
            bytes.push(byte);
            continue;
        }
        let high = input.next().and_then(hex_value)?;
        let low = input.next().and_then(hex_value)?;
        bytes.push(high << 4 | low);
    }
    String::from_utf8(bytes).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|digit| u8::try_from(digit).ok())
}

/// One name or value as `URLSearchParams` serialises it (`application/x-www-form-urlencoded`).
fn form_component(text: &str) -> String {
    let encoded = percent_encode(text, |b| b.is_ascii_alphanumeric() || b"*-._ ".contains(&b));
    encoded.replace(' ', "+")
}

/// `new URLSearchParams(pairs).toString()`.
pub fn form_urlencode(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{}={}", form_component(name), form_component(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// `new URLSearchParams(query)` (without the leading `?`): `+` is a space, bad `%` sequences stay as they are.
pub fn form_urldecode(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode_component(name), form_decode_component(value))
        })
        .collect()
}

fn form_decode_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let escaped = (byte == b'%')
            .then(|| {
                Some(hex_value(*bytes.get(index + 1)?)? << 4 | hex_value(*bytes.get(index + 2)?)?)
            })
            .flatten();
        match (byte, escaped) {
            (_, Some(decoded)) => {
                out.push(decoded);
                index += 3;
            }
            (b'+', None) => {
                out.push(b' ');
                index += 1;
            }
            (other, None) => {
                out.push(other);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_read_and_print_like_javascript() {
        assert_eq!(parse_number(" 0x1F "), Some(31.0));
        assert_eq!(parse_number("1e2"), Some(100.0));
        assert_eq!(parse_number(""), Some(0.0));
        assert_eq!(parse_number("inf"), None);
        assert_eq!(parse_number("-Infinity"), Some(f64::NEG_INFINITY));
        assert_eq!(number_string(1e21), "1e+21");
        assert_eq!(number_string(1.5e-7), "1.5e-7");
        assert_eq!(number_string(0.000001), "0.000001");
        assert_eq!(number_string(7.0), "7");
        assert_eq!(number_string(2.5), "2.5");
        assert_eq!(number_string(-0.001), "-0.001");
        assert_eq!(number_string(123.456), "123.456");
        assert_eq!(number_string(1.5e300), "1.5e+300");
        assert_eq!(parse_number(".5"), Some(0.5));
        assert_eq!(parse_number("5."), Some(5.0));
        assert_eq!(parse_number("+007"), Some(7.0));
        assert_eq!(parse_number("."), None);
        assert_eq!(parse_number("1e"), None);
    }

    #[test]
    fn url_encodings_match_javascript() {
        assert_eq!(encode_uri_component("a b/é!'"), "a%20b%2F%C3%A9!'");
        assert_eq!(decode_uri_component("%2e%2E"), Some("..".into()));
        assert_eq!(decode_uri_component("%zz"), None);
        let pairs = form_urldecode("a=1,2&b=x+y%20z&c=%zz&&d");
        assert_eq!(form_urlencode(&pairs), "a=1%2C2&b=x+y+z&c=%25zz&d=");
    }
}
