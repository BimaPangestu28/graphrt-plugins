//! WebAssembly build of the currency-rates plugin (Frankfurter v2). Every operation is declarative except
//! `convert`, which, like `createConvertOperation` in currency-rates/definition.mjs, reads the pair rate through
//! `get_pair_rate` and multiplies (rounded to 6 decimals like `Number((amount * rate).toFixed(6))`).

use rest_kit::{js, Hooks, Kit, Map, OperationResult, RestError, Value};

const RESULT_DECIMALS: u32 = 6;

/// The `convert` operation.
pub struct CurrencyRates;

impl Hooks for CurrencyRates {
    fn call(&self, kit: &Kit, name: &str, raw_arguments: &Value) -> Option<Result<OperationResult, RestError>> {
        (name == "convert").then(|| convert(kit, raw_arguments))
    }
}

fn convert(kit: &Kit, raw_arguments: &Value) -> Result<OperationResult, RestError> {
    let args = kit.validate("convert", raw_arguments)?;
    let client = kit.client("main", raw_arguments)?;
    let mut pair_args = Map::new();
    pair_args.insert("base".into(), args.get("from").cloned().unwrap_or(Value::Null));
    pair_args.insert("quote".into(), args.get("to").cloned().unwrap_or(Value::Null));
    if let Some(date) = args.get("date").filter(|date| js::is_truthy(Some(date))) {
        pair_args.insert("date".into(), date.clone());
    }
    let pair_rate = kit.run_rest_operation(&client, "get_pair_rate", pair_args)?.data;
    let amount = args.get("amount").cloned().unwrap_or(Value::Null);
    Ok(OperationResult::data(describe_conversion(amount, &pair_rate)?))
}

fn describe_conversion(amount: Value, pair_rate: &Value) -> Result<Value, RestError> {
    let Some(rate) = pair_rate.get("rate").filter(|rate| rate.is_number()) else {
        return Err(RestError::new("api_error", "Frankfurter returned no rate for this pair"));
    };
    let product = amount.as_f64().unwrap_or(f64::NAN) * rate.as_f64().unwrap_or(f64::NAN);
    let result = js::parse_number(&to_fixed(product, RESULT_DECIMALS));
    let upper = |field: &str| {
        Value::String(pair_rate.get(field).map_or_else(|| "undefined".into(), js::to_text).to_ascii_uppercase())
    };
    let mut conversion = Map::new();
    conversion.insert("amount".into(), amount);
    conversion.insert("from".into(), upper("base"));
    conversion.insert("to".into(), upper("quote"));
    // JSON.stringify drops an undefined date.
    if let Some(date) = pair_rate.get("date") {
        conversion.insert("date".into(), date.clone());
    }
    conversion.insert("rate".into(), rate.clone());
    conversion.insert("result".into(), if result.is_finite() { js::number_value(result) } else { Value::Null });
    Ok(Value::Object(conversion))
}

/// `Number.prototype.toFixed(digits)` for |value| < 1e21: the integer n nearest to value × 10^digits on the exact
/// binary value, the larger one on a tie (Rust's formatting rounds half to even), written with `digits` decimals.
fn to_fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return js::format_number(value);
    }
    let bits = value.abs().to_bits();
    let biased_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1 << 52) - 1);
    let (mantissa, exponent) =
        if biased_exponent == 0 { (fraction, -1074) } else { (fraction | (1 << 52), biased_exponent - 1075) };
    // |value| < 1e21 < 2^70, so mantissa × 10^digits × 2^exponent fits in u128 for digits <= 8.
    let scaled = u128::from(mantissa) * 10u128.pow(digits);
    let rounded = if exponent >= 0 {
        scaled << exponent
    } else {
        let shift = (-exponent) as u32;
        if shift >= 128 {
            0
        } else {
            let half = 1u128 << (shift - 1);
            (scaled >> shift) + u128::from(scaled & ((1u128 << shift) - 1) >= half)
        }
    };
    let text = format!("{:0>width$}", rounded, width = digits as usize + 1);
    let (integer_part, fraction_part) = text.split_at(text.len() - digits as usize);
    let sign = if value < 0.0 { "-" } else { "" };
    format!("{sign}{integer_part}.{fraction_part}")
}

pub const MANIFEST: &str = include_str!("../manifest.json");
pub const SPEC: &str = include_str!("../spec.json");

rest_kit::export_rest_plugin!(MANIFEST, SPEC, CurrencyRates);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_rounds_like_javascript() {
        assert_eq!(to_fixed(0.0078125, 6), "0.007813");
        assert_eq!(to_fixed(1.0000005, 6), "1.000001");
        assert_eq!(to_fixed(16_250.123_456_49, 6), "16250.123456");
        assert_eq!(to_fixed(-0.0000001, 6), "-0.000000");
        assert_eq!(to_fixed(999.9999999, 6), "1000.000000");
        assert_eq!(to_fixed(2.5e-7, 6), "0.000000");
        assert_eq!(to_fixed(123_456_789.123_456_5, 6), "123456789.123456");
    }
}
