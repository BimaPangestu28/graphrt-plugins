//! Object paths of the declarative spec (port of `object-path.mjs`): dot-separated keys (`data.items.0.id`), `\.`
//! for a literal dot, bracket-quoted keys (`["@odata.nextLink"]`). Numeric segments index arrays.

use serde_json::{Map, Value};

use crate::error::RestError;

const FORBIDDEN_SEGMENTS: [&str; 3] = ["__proto__", "prototype", "constructor"];

/// Splits a path into keys; `[]` (flatten) segments are dropped, they only matter for collecting.
pub fn parse_path(path: &str) -> Vec<String> {
    let characters: Vec<char> = path.chars().collect();
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut has_key = false;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '\\' && index + 1 < characters.len() {
            index += 1;
            current.push(characters[index]);
            has_key = true;
        } else if character == '.' || character == '[' {
            if has_key {
                segments.push(std::mem::take(&mut current));
            }
            has_key = false;
            if character == '[' {
                index = read_bracket(&characters, index, &mut segments);
            }
        } else {
            current.push(character);
            has_key = true;
        }
        index += 1;
    }
    if has_key {
        segments.push(current);
    }
    segments
}

fn read_bracket(characters: &[char], open: usize, segments: &mut Vec<String>) -> usize {
    let quote = characters.get(open + 1).copied();
    if quote == Some(']') {
        return open + 1;
    }
    if let Some(quote @ ('"' | '\'')) = quote {
        let mut close = open + 2;
        while close + 1 < characters.len() {
            if characters[close] == quote && characters[close + 1] == ']' {
                segments.push(characters[open + 2..close].iter().collect());
                return close + 1;
            }
            close += 1;
        }
    }
    // Specs are validated by the Node.js layer; a malformed bracket reads nothing.
    segments.push(String::from("\u{0}malformed"));
    characters.len()
}

/// `readPath(value, path)`: `None` when a segment is missing (JavaScript `undefined`).
pub fn read_path<'a>(value: &'a Value, path: Option<&str>) -> Option<&'a Value> {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return Some(value);
    };
    parse_path(path).iter().try_fold(value, |current, segment| read_own(current, segment))
}

fn read_own<'a>(current: &'a Value, segment: &str) -> Option<&'a Value> {
    match current {
        Value::Object(map) => map.get(segment),
        Value::Array(items) => canonical_index(segment).and_then(|index| items.get(index)),
        _ => None,
    }
}

// "0", "12": array indexes JavaScript treats as own properties ("01" is not one).
fn canonical_index(segment: &str) -> Option<usize> {
    let index = segment.parse::<usize>().ok()?;
    (index.to_string() == segment).then_some(index)
}

/// `writePath(target, path, value)`: creates plain objects for every missing segment.
pub fn write_path(target: &mut Map<String, Value>, path: &str, value: Value) -> Result<(), RestError> {
    let segments = parse_path(path);
    if let Some(forbidden) = segments.iter().find(|segment| FORBIDDEN_SEGMENTS.contains(&segment.as_str())) {
        return Err(RestError::plugin(format!("Refusing to write the path segment \"{forbidden}\" in {path}")));
    }
    let Some((last, parents)) = segments.split_last() else {
        return Err(RestError::plugin(format!("Cannot write to the path {}", crate::js::json_string(path))));
    };
    let mut current = target;
    for segment in parents {
        let entry = current.entry(segment.clone()).or_insert(Value::Null);
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        current = entry.as_object_mut().expect("just made an object");
    }
    current.insert(last.clone(), value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_and_writes_paths() {
        let body = json!({"query": {"pages": [{"title": "A"}]}, "@odata.nextLink": "n", "a.b": 1});
        assert_eq!(read_path(&body, Some("query.pages.0.title")), Some(&json!("A")));
        assert_eq!(read_path(&body, Some("[\"@odata.nextLink\"]")), Some(&json!("n")));
        assert_eq!(read_path(&body, Some("a\\.b")), Some(&json!(1)));
        assert_eq!(read_path(&body, Some("query.pages.01")), None);
        let mut target = Map::new();
        write_path(&mut target, "message.text", json!("hi")).unwrap();
        assert_eq!(Value::Object(target), json!({"message": {"text": "hi"}}));
    }
}
