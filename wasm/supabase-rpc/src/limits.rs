//! Result size caps for tools (port of `capToolRows` and `truncateForTool`).

use graphrt_wasm_guest::{json, Value};

use crate::settings::MAX_ROWS_ENV;

/// Longest tool result, in UTF-16 code units of its JSON text (JavaScript string length).
const MAX_TOOL_CHARS: usize = 100_000;

/// Cut an array result to `max_rows` rows with a note; other results only get the size cap.
pub fn cap_tool_rows(data: Value, max_rows: usize) -> Value {
    let total = data.as_array().map(Vec::len);
    let shortened = truncate_for_tool(data, max_rows);
    match total {
        Some(total) if total > max_rows && shortened.get("items").is_some() => {
            let mut object = shortened;
            let note = format!(
                "Only the first {max_rows} of {total} rows are shown ({MAX_ROWS_ENV}); ask for fewer rows if you need the rest"
            );
            if let Some(map) = object.as_object_mut() {
                map.insert("note".into(), Value::String(note));
            }
            object
        }
        _ => shortened,
    }
}

fn truncate_for_tool(data: Value, max_items: usize) -> Value {
    if data.is_null() {
        return data;
    }
    let shortened = match data {
        Value::Array(mut items) if items.len() > max_items => {
            let total = items.len();
            items.truncate(max_items);
            json!({"truncated": true, "items": items, "total_items": total})
        }
        other => other,
    };
    let text = shortened.to_string();
    let length = utf16_len(&text);
    if length <= MAX_TOOL_CHARS {
        return shortened;
    }
    json!({"truncated": true, "preview": utf16_prefix(&text, MAX_TOOL_CHARS), "total_chars": length})
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The longest prefix of at most `limit` UTF-16 code units (never splitting a character).
fn utf16_prefix(text: &str, limit: usize) -> &str {
    let mut used = 0;
    for (index, character) in text.char_indices() {
        used += character.len_utf16();
        if used > limit {
            return &text[..index];
        }
    }
    text
}
