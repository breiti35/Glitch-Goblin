use serde::{Deserialize, Serialize};

/// A bug as returned by the Portal API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortalBug {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub reporter_name: Option<String>,
    #[serde(default)]
    pub screenshot_url: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub portal_url: Option<String>,
}

/// Response wrapper from the Portal API.
#[derive(Debug, Deserialize)]
pub struct PortalBugResponse {
    #[serde(default)]
    pub bugs: Vec<PortalBug>,
}

/// Validate that a URL uses http or https scheme.
fn validate_api_url(url: &str) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Bug-Sync: API URL must start with http:// or https://".to_string());
    }
    Ok(())
}

/// Validate that an API token contains no dangerous characters.
fn validate_api_token(token: &str) -> Result<(), String> {
    if token.contains('\n') || token.contains('\r') || token.contains('\0') {
        return Err("Bug-Sync: API token contains invalid characters".to_string());
    }
    Ok(())
}

const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024; // 10 MB

/// Fetch unsynced bugs from the Portal API.
pub async fn fetch_unsynced_bugs(api_url: &str, api_token: &str) -> Result<Vec<PortalBug>, String> {
    validate_api_url(api_url)?;

    let url = if api_url.ends_with('/') {
        format!("{api_url}unsynced")
    } else {
        format!("{api_url}/unsynced")
    };

    let client = reqwest::Client::new();
    let mut request = client.get(&url);

    if !api_token.is_empty() {
        validate_api_token(api_token)?;
        request = request.header("Authorization", format!("Bearer {api_token}"));
    }

    let response = request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Bug-Sync request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Bug-Sync API returned status {}",
            response.status()
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Bug-Sync: failed to read response: {e}"))?;

    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("Bug-Sync: response too large".to_string());
    }

    let body: PortalBugResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("Bug-Sync: failed to parse response: {e}"))?;

    Ok(body.bugs)
}

/// Mark bugs as synced on the Portal API.
pub async fn mark_bugs_synced(
    api_url: &str,
    api_token: &str,
    bug_ids: &[u64],
    ticket_ids: &[String],
) -> Result<(), String> {
    if bug_ids.is_empty() {
        return Ok(());
    }

    validate_api_url(api_url)?;

    let url = if api_url.ends_with('/') {
        format!("{api_url}mark-synced")
    } else {
        format!("{api_url}/mark-synced")
    };

    let payload: Vec<_> = bug_ids
        .iter()
        .zip(ticket_ids.iter())
        .map(|(bug_id, ticket_id)| {
            serde_json::json!({
                "bug_id": bug_id,
                "kanban_ticket_id": ticket_id,
            })
        })
        .collect();

    let client = reqwest::Client::new();
    let mut request = client.post(&url).json(&payload);

    if !api_token.is_empty() {
        request = request.header("Authorization", format!("Bearer {api_token}"));
    }

    let response = request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Bug-Sync mark-synced failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Bug-Sync mark-synced API returned status {}",
            response.status()
        ));
    }

    Ok(())
}
