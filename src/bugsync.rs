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

/// Fetch unsynced bugs from the Portal API.
pub async fn fetch_unsynced_bugs(api_url: &str, api_token: &str) -> Result<Vec<PortalBug>, String> {
    let url = if api_url.ends_with('/') {
        format!("{}unsynced", api_url)
    } else {
        format!("{}/unsynced", api_url)
    };

    let client = reqwest::Client::new();
    let mut request = client.get(&url);

    if !api_token.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", api_token));
    }

    let response = request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Bug-Sync request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Bug-Sync API returned status {}", response.status()));
    }

    let body: PortalBugResponse = response
        .json()
        .await
        .map_err(|e| format!("Bug-Sync: failed to parse response: {e}"))?;

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

    let url = if api_url.ends_with('/') {
        format!("{}mark-synced", api_url)
    } else {
        format!("{}/mark-synced", api_url)
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
        request = request.header("Authorization", format!("Bearer {}", api_token));
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
