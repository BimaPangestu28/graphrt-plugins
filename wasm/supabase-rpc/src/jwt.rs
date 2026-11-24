//! End-user JWT checks (port of `readUserJwt`).

use graphrt_wasm_guest::{serde_json, PluginError, Value};

/// The JWT from the tool context, refusing a missing, masked or service_role token.
pub fn read_user_jwt(secret: Option<&str>) -> Result<String, PluginError> {
    let token = secret.map(str::trim).unwrap_or_default();
    let Some(payload) = payload_of(token) else {
        return Err(PluginError::new(
            "auth_error",
            "No signed-in user for this call: the agent node must pass the user's access token as tool_context.supabase.user_jwt, \
             and the plugin must be trusted (--trust-plugin supabase). The call was refused",
        ));
    };
    if role_of(payload).as_deref() == Some("service_role") {
        return Err(PluginError::new(
            "auth_error",
            "The user token has the service_role role, which bypasses row level security; pass the end user's access token",
        ));
    }
    Ok(token.to_owned())
}

/// The payload part of `header.payload.signature` (`^[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$`).
pub fn payload_of(token: &str) -> Option<&str> {
    let mut parts = token.split('.');
    let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    let valid = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    (parts.next().is_none() && valid(header) && valid(payload) && valid(signature))
        .then_some(payload)
}

/// `role` claim of a base64url JSON payload.
pub fn role_of(payload: &str) -> Option<String> {
    let json: Value = serde_json::from_slice(&decode_base64url(payload)).ok()?;
    json.get("role")?.as_str().map(str::to_owned)
}

/// Lenient base64url decoding like Node's `Buffer.from(text, "base64url")`.
fn decode_base64url(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => continue,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}
