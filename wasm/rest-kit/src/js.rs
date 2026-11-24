//! JavaScript value semantics the Node.js plugins rely on: `JSON.stringify`, `String(value)`, `Number(value)`,
//! number-to-text, `String.prototype.trim` and string length in UTF-16 code units. Results, request bodies,
//! query strings and error messages must be byte for byte what the Node.js plugin produces.

use serde_json::Value;

/// Largest integer JavaScript represents exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `JSON.stringify(value)`: compact, keys in order, numbers as JavaScript prints them.
pub fn stringify(value: &Value) -> String {
    let mut text = String::new();
    write_json(&mut text, value);
    text
}

fn write_json(text: &mut String, value: &Value) {
    match value {
        Value::Null => text.push_str("null"),
        Value::Bool(flag) => text.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => text.push_str(&number_text(number)),
        Value::String(string) => write_json_string(text, string),
        Value::Array(items) => {
            text.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    text.push(',');
                }
                write_json(text, item);
            }
            text.push(']');
        }
        Value::Object(map) => {
            text.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    text.push(',');
                }
                write_json_string(text, key);
                text.push(':');
                write_json(text, item);
            }
            text.push('}');
        }
    }
}

/// A JSON string literal as `JSON.stringify` writes it.
pub fn json_string(string: &str) -> String {
    let mut text = String::with_capacity(string.len() + 2);
    write_json_string(&mut text, string);
    text
}

fn write_json_string(text: &mut String, string: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    text.push('"');
    for character in string.chars() {
        match character {
            '"' => text.push_str("\\\""),
            '\\' => text.push_str("\\\\"),
            '\u{8}' => text.push_str("\\b"),
            '\u{c}' => text.push_str("\\f"),
            '\n' => text.push_str("\\n"),
            '\r' => text.push_str("\\r"),
            '\t' => text.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                let code = control as usize;
                text.push_str("\\u00");
                text.push(HEX[code >> 4] as char);
                text.push(HEX[code & 0xf] as char);
            }
            other => text.push(other),
        }
    }
    text.push('"');
}

/// `JSON.stringify(value).length` (UTF-16 code units) without building the text.
pub fn stringified_len(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(flag) => {
            if *flag {
                4
            } else {
                5
            }
        }
        Value::Number(number) => number_text(number).len(),
        Value::String(string) => string_literal_len(string),
        Value::Array(items) => 2 + items.len().saturating_sub(1) + items.iter().map(stringified_len).sum::<usize>(),
        Value::Object(map) => {
            let members: usize =
                map.iter().map(|(key, item)| string_literal_len(key) + 1 + stringified_len(item)).sum();
            2 + map.len().saturating_sub(1) + members
        }
    }
}

fn string_literal_len(string: &str) -> usize {
    let escaped: usize = string
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            control if (control as u32) < 0x20 => 6,
            other => other.len_utf16(),
        })
        .sum();
    escaped + 2
}

/// The number as JavaScript prints it; integers beyond 2^53 are rounded like `JSON.parse` does.
pub fn number_text(number: &serde_json::Number) -> String {
    if let Some(integer) = number.as_i64() {
        if (integer.unsigned_abs() as f64) <= MAX_SAFE_INTEGER {
            return integer.to_string();
        }
    }
    if let Some(integer) = number.as_u64() {
        if (integer as f64) <= MAX_SAFE_INTEGER {
            return integer.to_string();
        }
    }
    format_number(number.as_f64().unwrap_or(f64::NAN))
}

/// `Number.prototype.toString()` for any f64.
pub fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if value == 0.0 {
        return "0".into();
    }
    let mut buffer = ryu::Buffer::new();
    let shortest = buffer.format_finite(value.abs());
    let (digits, point) = decimal_digits(shortest);
    let sign = if value < 0.0 { "-" } else { "" };
    format!("{sign}{}", place_point(&digits, point))
}

// ryu's shortest text ("1.5e-7", "123.0", "1e21") as significant digits and the position of the decimal point.
fn decimal_digits(shortest: &str) -> (String, i32) {
    let (mantissa, exponent) = match shortest.split_once('e') {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().unwrap_or(0)),
        None => (shortest, 0),
    };
    let (integer_part, fraction_part) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let mut digits: String = format!("{integer_part}{fraction_part}");
    let mut point = integer_part.len() as i32 + exponent;
    let leading_zeros = digits.len() - digits.trim_start_matches('0').len();
    digits.drain(..leading_zeros);
    point -= leading_zeros as i32;
    let trimmed_length = digits.trim_end_matches('0').len();
    digits.truncate(trimmed_length);
    (digits, point)
}

// ECMAScript Number::toString with the digits `digits` and decimal exponent `point` (value = 0.digits × 10^point).
fn place_point(digits: &str, point: i32) -> String {
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
    let exponent_sign = if exponent >= 0 { "+" } else { "-" };
    let (first, rest) = digits.split_at(1);
    let fraction = if rest.is_empty() { String::new() } else { format!(".{rest}") };
    format!("{first}{fraction}e{exponent_sign}{}", exponent.unsigned_abs())
}

/// `String(value)`: arrays are joined with commas (null items empty), objects are `[object Object]`.
pub fn to_text(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_text(number),
        Value::String(string) => string.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { to_text(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number(value)` for a JSON value.
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(string) => parse_number(string),
        Value::Array(_) => parse_number(&to_text(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// `Number(text)`: decimal, `0x`/`0o`/`0b` integers, `Infinity`; anything else is NaN; blank is 0.
pub fn parse_number(text: &str) -> f64 {
    let trimmed = trim(text);
    if trimmed.is_empty() {
        return 0.0;
    }
    let prefixed = [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)];
    for (prefix, radix) in prefixed {
        if let Some(digits) = trimmed.strip_prefix(prefix) {
            return parse_radix(digits, radix);
        }
    }
    let (negative, unsigned) = match trimmed.as_bytes()[0] {
        b'-' => (true, &trimmed[1..]),
        b'+' => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    if unsigned == "Infinity" {
        return if negative { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let magnitude = parse_unsigned_decimal(unsigned);
    if negative {
        -magnitude
    } else {
        magnitude
    }
}

// A JavaScript StrUnsignedDecimalLiteral ("12", ".5", "5.", "1e-3", "007") rewritten as a JSON number and read with
// serde_json's exact float parser (no second float parser in the module).
fn parse_unsigned_decimal(text: &str) -> f64 {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(index) => (&text[..index], Some(&text[index + 1..])),
        None => (text, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let is_digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if (whole.is_empty() && fraction.is_empty()) || !is_digits(whole) || !is_digits(fraction) {
        return f64::NAN;
    }
    let mut json_number = whole.trim_start_matches('0').to_owned();
    if json_number.is_empty() {
        json_number.push('0');
    }
    if !fraction.is_empty() {
        json_number.push('.');
        json_number.push_str(fraction);
    }
    if let Some(exponent) = exponent {
        let digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
        if digits.is_empty() || !is_digits(digits) {
            return f64::NAN;
        }
        json_number.push('e');
        json_number.push_str(exponent);
    }
    match serde_json::from_str::<serde_json::Value>(&json_number) {
        Ok(number) => number.as_f64().unwrap_or(f64::NAN),
        // Out of range: JavaScript rounds to Infinity or 0.
        Err(_) if exponent.is_some_and(|exponent| exponent.starts_with('-')) => 0.0,
        Err(_) => f64::INFINITY,
    }
}

fn parse_radix(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut total = 0.0_f64;
    for character in digits.chars() {
        match character.to_digit(radix) {
            Some(digit) => total = total * f64::from(radix) + f64::from(digit),
            None => return f64::NAN,
        }
    }
    total
}

/// `String.prototype.trim`: Unicode white space, line terminators and the BOM.
pub fn trim(text: &str) -> &str {
    text.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

/// `text.length`: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `text.slice(0, limit)` without splitting a character.
pub fn utf16_prefix(text: &str, limit: usize) -> &str {
    let mut used = 0;
    for (index, character) in text.char_indices() {
        used += character.len_utf16();
        if used > limit {
            return &text[..index];
        }
    }
    text
}

/// JavaScript truthiness of a JSON value (`undefined` is `None`).
pub fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|float| float != 0.0 && !float.is_nan()),
        Some(Value::String(string)) => !string.is_empty(),
        Some(_) => true,
    }
}

/// A finite f64 as a JSON value, integral values as integers (as `JSON.parse` would read them back).
pub fn number_value(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= MAX_SAFE_INTEGER {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_javascript() {
        let cases = [
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (123.0, "123"),
            (1.5e300, "1.5e+300"),
            (-0.0, "0"),
            (2f64.powi(60), "1152921504606847000"),
            (25.3, "25.3"),
            (-1.25e-10, "-1.25e-10"),
            (123456789012.5, "123456789012.5"),
            (1e20, "100000000000000000000"),
        ];
        for (value, expected) in cases {
            assert_eq!(format_number(value), expected, "{value}");
        }
        assert_eq!(
            stringify(&json!({"a": 38.0, "b": [1, -2.5], "c": "x\u{1}\"y"})),
            r#"{"a":38,"b":[1,-2.5],"c":"x\u0001\"y"}"#
        );
        assert_eq!(stringify(&json!(12345678901234567890u64)), "12345678901234567000");
        let sample = json!({"a": [1.5, null, true, "é\u{1}\"🙂"], "b": {}, "c": []});
        assert_eq!(stringified_len(&sample), utf16_len(&stringify(&sample)));
    }

    #[test]
    fn numbers_parse_like_javascript() {
        assert_eq!(parse_number(" 12 "), 12.0);
        assert_eq!(parse_number("0x10"), 16.0);
        assert_eq!(parse_number(".5"), 0.5);
        assert!(parse_number("inf").is_nan());
        assert!(parse_number("1_0").is_nan());
        assert_eq!(parse_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(parse_number("+5."), 5.0);
        assert_eq!(parse_number("-007.25e1"), -72.5);
        assert_eq!(parse_number("1e400"), f64::INFINITY);
        assert!(parse_number("1e").is_nan());
        assert!(parse_number("--1").is_nan());
        assert_eq!(parse_number("107.61861"), 107.61861);
        assert_eq!(to_text(&json!([1, null, [2, 3], "a"])), "1,,2,3,a");
    }
}
