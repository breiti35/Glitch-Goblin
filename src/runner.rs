#[allow(dead_code)]
/// Token usage parsed from Claude output
#[derive(Default, Clone)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cache_hits: u64,
}

#[allow(dead_code)]
/// Parse token information from Claude CLI output lines
pub fn parse_token_usage(lines: &[String]) -> Option<TokenUsage> {
    let mut usage = TokenUsage::default();
    let mut found = false;

    // Scan last 20 lines for token information
    let start = lines.len().saturating_sub(20);
    for line in &lines[start..] {
        let lower = line.to_lowercase();

        if let Some(n) = extract_number(&lower, "input") {
            usage.input_tokens = n;
            found = true;
        }
        if let Some(n) = extract_number(&lower, "output") {
            usage.output_tokens = n;
            found = true;
        }
        if let Some(n) = extract_number(&lower, "total") {
            usage.total_tokens = n;
            found = true;
        }
        if let Some(n) = extract_number(&lower, "cache") {
            usage.cache_hits = n;
            found = true;
        }
    }

    if usage.total_tokens == 0 && (usage.input_tokens > 0 || usage.output_tokens > 0) {
        usage.total_tokens = usage.input_tokens + usage.output_tokens;
    }

    if found {
        Some(usage)
    } else {
        None
    }
}

#[allow(dead_code)]
fn extract_number(line: &str, keyword: &str) -> Option<u64> {
    if !line.contains(keyword) {
        return None;
    }
    // Find sequences of digits after the keyword
    let after = line.split(keyword).nth(1)?;
    for word in after.split_whitespace() {
        let clean: String = word.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = clean.parse::<u64>() {
            if n > 0 {
                return Some(n);
            }
        }
    }
    None
}

#[allow(dead_code)]
pub fn calculate_cost(usage: &TokenUsage, cost_input: f64, cost_output: f64) -> f64 {
    (usage.input_tokens as f64 * cost_input + usage.output_tokens as f64 * cost_output)
        / 1_000_000.0
}
