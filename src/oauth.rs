//! Anthropic OAuth 2.0 PKCE Flow.
//!
//! Implements the Authorization Code flow with PKCE for desktop apps:
//! 1. Generate code_verifier + code_challenge (S256)
//! 2. Open browser to Anthropic authorization URL
//! 3. Listen on localhost for the redirect callback
//! 4. Exchange authorization code for access + refresh tokens
//! 5. Refresh tokens before expiry

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tracing::info;

/// Anthropic OAuth client ID.  Replace with the registered client ID.
const CLIENT_ID: &str = "glitch-goblin-desktop";

/// Anthropic OAuth endpoints.
const AUTH_URL: &str = "https://console.anthropic.com/oauth/authorize";
const TOKEN_URL: &str = "https://api.anthropic.com/api/oauth/token";

/// Timeout for the entire OAuth flow (user has this long to authorize).
const FLOW_TIMEOUT: Duration = Duration::from_secs(300);

/// HTTP request timeout for token exchange/refresh.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Scope requested from Anthropic.
const SCOPE: &str = "org:usage";

// ── PKCE ──────────────────────────────────────────────────────────────────────

/// Generate a cryptographically random code verifier (43-128 chars, base64url).
fn generate_code_verifier() -> String {
    // Two UUID v4 (each 16 random bytes from CSPRNG) = 32 bytes of randomness
    let u1 = uuid::Uuid::new_v4();
    let u2 = uuid::Uuid::new_v4();
    let mut buf = [0u8; 32];
    buf[..16].copy_from_slice(u1.as_bytes());
    buf[16..].copy_from_slice(u2.as_bytes());
    URL_SAFE_NO_PAD.encode(buf)
}

/// Compute the S256 code challenge: BASE64URL(SHA256(code_verifier)).
fn code_challenge(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hash)
}

/// Generate a random state parameter (CSRF protection).
fn generate_state() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ── Browser ───────────────────────────────────────────────────────────────────

/// Open a URL in the user's default browser (cross-platform).
fn open_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = crate::process_util::cmd_no_window("cmd");
        cmd.args(["/C", "start", "", url]);
        cmd.spawn().map_err(|e| format!("Browser oeffnen fehlgeschlagen: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Browser oeffnen fehlgeschlagen: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Browser oeffnen fehlgeschlagen: {e}"))?;
    }
    Ok(())
}

// ── Localhost Redirect Server ─────────────────────────────────────────────────

/// Success page returned to the browser after a successful OAuth callback.
const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Glitch Goblin</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
.box{text-align:center;padding:40px;border-radius:12px;background:#16213e;box-shadow:0 4px 20px rgba(0,0,0,.4)}
h1{color:#f97316;margin-bottom:8px}p{color:#a0a0a0}</style></head>
<body><div class="box"><h1>&#128126; Verbunden!</h1><p>Du kannst dieses Fenster schliessen und zu Glitch Goblin zurueckkehren.</p></div></body></html>"#;

/// Error page returned when the callback contains an error.
const ERROR_HTML: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Glitch Goblin</title>
<style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
.box{text-align:center;padding:40px;border-radius:12px;background:#16213e;box-shadow:0 4px 20px rgba(0,0,0,.4)}
h1{color:#ef4444;margin-bottom:8px}p{color:#a0a0a0}</style></head>
<body><div class="box"><h1>Fehler</h1><p>Autorisierung fehlgeschlagen. Bitte versuche es erneut in Glitch Goblin.</p></div></body></html>"#;

/// Parse query parameters from a raw HTTP request line.
/// Returns a Vec of (key, value) pairs.
fn parse_query_params(request_line: &str) -> Vec<(String, String)> {
    // Request line: "GET /callback?code=xxx&state=yyy HTTP/1.1"
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("");
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((
                urldecode(k),
                urldecode(v),
            ))
        })
        .collect()
}

/// Minimal percent-decode (handles the common cases in OAuth callbacks).
fn urldecode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.bytes();
    while let Some(b) = chars.next() {
        if b == b'+' {
            result.push(' ');
        } else if b == b'%' {
            let hi = chars.next().unwrap_or(b'0');
            let lo = chars.next().unwrap_or(b'0');
            let hex = [hi, lo];
            if let Ok(val) = u8::from_str_radix(std::str::from_utf8(&hex).unwrap_or("00"), 16) {
                result.push(val as char);
            }
        } else {
            result.push(b as char);
        }
    }
    result
}

/// Listen on a localhost port for the OAuth callback.
/// Loops to handle spurious connections (browser prefetch, favicon, port scanners)
/// and only returns when a valid `/callback?code=...` request arrives.
async fn wait_for_callback(listener: tokio::net::TcpListener) -> Result<(String, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    loop {
        let (mut stream, _addr) = listener
            .accept()
            .await
            .map_err(|e| format!("Callback-Server accept fehlgeschlagen: {e}"))?;

        // Read the HTTP request (just the first line is enough)
        let mut buf = vec![0u8; 4096];
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("Callback lesen fehlgeschlagen: {e}"))?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let first_line = request.lines().next().unwrap_or("");

        // Only process requests to /callback with query params
        let path = first_line.split_whitespace().nth(1).unwrap_or("");
        if !path.starts_with("/callback?") && !path.starts_with("/callback?") {
            // Not the OAuth callback — respond with 404 and continue listening
            let response = "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(response.as_bytes()).await;
            continue;
        }

        let params = parse_query_params(first_line);

        // Check for error in callback
        let error = params.iter().find(|(k, _)| k == "error").map(|(_, v)| v.clone());
        if let Some(err) = error {
            let error_desc = params
                .iter()
                .find(|(k, _)| k == "error_description")
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{}",
                ERROR_HTML
            );
            let _ = stream.write_all(response.as_bytes()).await;
            return Err(format!("OAuth Fehler: {err} — {error_desc}"));
        }

        let code = match params.iter().find(|(k, _)| k == "code").map(|(_, v)| v.clone()) {
            Some(c) => c,
            None => {
                // /callback without code param — respond and continue
                let response = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
                continue;
            }
        };

        let state = match params.iter().find(|(k, _)| k == "state").map(|(_, v)| v.clone()) {
            Some(s) => s,
            None => {
                let response = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
                continue;
            }
        };

        // Valid callback — send success page
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n{}",
            SUCCESS_HTML
        );
        let _ = stream.write_all(response.as_bytes()).await;

        return Ok((code, state));
    }
}

// ── Token Exchange ────────────────────────────────────────────────────────────

/// Tokens returned by the OAuth token endpoint.
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// ISO-8601 expiry timestamp (computed from expires_in).
    pub expires_at: String,
}

/// Exchange an authorization code for tokens.
async fn exchange_code(
    client: &reqwest::Client,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthTokens, String> {
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
        ])
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Token-Austausch fehlgeschlagen: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token-Endpoint Fehler {status}: {body}"));
    }

    parse_token_response(resp).await
}

/// Refresh an expired access token.
pub async fn refresh_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<OAuthTokens, String> {
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Token-Refresh fehlgeschlagen: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token-Refresh Fehler {status}: {body}"));
    }

    parse_token_response(resp).await
}

/// Parse the JSON token response from the OAuth token endpoint.
async fn parse_token_response(resp: reqwest::Response) -> Result<OAuthTokens, String> {
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Token-Antwort parsen fehlgeschlagen: {e}"))?;

    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Kein access_token in Antwort")?
        .to_string();

    let refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);

    let expires_at = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::seconds(expires_in as i64))
        .map(|t| t.to_rfc3339())
        .unwrap_or_default();

    Ok(OAuthTokens {
        access_token,
        refresh_token,
        expires_at,
    })
}

// ── Main OAuth Flow ───────────────────────────────────────────────────────────

/// Run the full OAuth PKCE authorization flow.
///
/// 1. Bind localhost redirect server
/// 2. Open browser to Anthropic authorization page
/// 3. Wait for callback with authorization code
/// 4. Exchange code for tokens
pub async fn run_oauth_flow(client: &reqwest::Client) -> Result<OAuthTokens, String> {
    // 1. PKCE
    let code_verifier = generate_code_verifier();
    let challenge = code_challenge(&code_verifier);
    let state = generate_state();

    // 2. Start localhost listener on a random port
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Localhost-Server starten fehlgeschlagen: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Port ermitteln fehlgeschlagen: {e}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    info!(port, "OAuth redirect server gestartet");

    // 3. Build authorization URL and open browser
    let auth_url = format!(
        "{AUTH_URL}?response_type=code&client_id={}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state={}&scope={SCOPE}",
        urlenc(CLIENT_ID),
        urlenc(&redirect_uri),
        urlenc(&challenge),
        urlenc(&state),
    );

    open_browser(&auth_url)?;
    info!("Browser geoeffnet fuer OAuth-Autorisierung");

    // 4. Wait for callback (with timeout)
    let (auth_code, returned_state) = tokio::time::timeout(FLOW_TIMEOUT, wait_for_callback(listener))
        .await
        .map_err(|_| "OAuth-Autorisierung Timeout (5 Minuten abgelaufen)".to_string())?
        .map_err(|e| e)?;

    // 5. Validate state (CSRF protection)
    if returned_state != state {
        return Err("OAuth State stimmt nicht ueberein (moeglicher CSRF-Angriff)".to_string());
    }

    info!("Authorization Code erhalten, tausche gegen Token");

    // 6. Exchange code for tokens
    let tokens = exchange_code(client, &auth_code, &code_verifier, &redirect_uri).await?;

    info!("OAuth-Token erfolgreich erhalten");

    Ok(tokens)
}

/// Check if an access token is expired (or about to expire within 60 seconds).
pub fn is_token_expired(expires_at: &str) -> bool {
    if expires_at.is_empty() {
        return true;
    }
    let Ok(expiry) = chrono::DateTime::parse_from_rfc3339(expires_at) else {
        return true;
    };
    let now = chrono::Utc::now();
    let buffer = chrono::Duration::seconds(60);
    now + buffer >= expiry
}

/// Minimal percent-encode for URL query parameter values.
fn urlenc(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push('%');
                result.push_str(&format!("{b:02X}"));
            }
        }
    }
    result
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_verifier_length() {
        let v = generate_code_verifier();
        // 32 bytes -> 43 base64url chars
        assert_eq!(v.len(), 43);
        // Must be URL-safe
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn code_challenge_is_sha256_base64url() {
        let verifier = "test-verifier-12345";
        let challenge = code_challenge(verifier);
        // SHA-256 produces 32 bytes -> 43 base64url chars
        assert_eq!(challenge.len(), 43);
        assert!(challenge.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn code_challenge_deterministic() {
        let v = "my-verifier";
        assert_eq!(code_challenge(v), code_challenge(v));
    }

    #[test]
    fn state_is_uuid() {
        let s = generate_state();
        assert!(uuid::Uuid::parse_str(&s).is_ok());
    }

    #[test]
    fn parse_query_params_basic() {
        let line = "GET /callback?code=abc123&state=xyz789 HTTP/1.1";
        let params = parse_query_params(line);
        assert_eq!(params.len(), 2);
        assert_eq!(params[0], ("code".into(), "abc123".into()));
        assert_eq!(params[1], ("state".into(), "xyz789".into()));
    }

    #[test]
    fn parse_query_params_encoded() {
        let line = "GET /callback?code=a%20b&state=c%2Bd HTTP/1.1";
        let params = parse_query_params(line);
        assert_eq!(params[0].1, "a b");
        assert_eq!(params[1].1, "c+d");
    }

    #[test]
    fn parse_query_params_empty() {
        let line = "GET /callback HTTP/1.1";
        let params = parse_query_params(line);
        assert!(params.is_empty());
    }

    #[test]
    fn urlenc_basic() {
        assert_eq!(urlenc("hello world"), "hello%20world");
        assert_eq!(urlenc("a=b&c"), "a%3Db%26c");
        assert_eq!(urlenc("safe-_.~"), "safe-_.~");
    }

    #[test]
    fn urldecode_basic() {
        assert_eq!(urldecode("hello%20world"), "hello world");
        assert_eq!(urldecode("a+b"), "a b");
        assert_eq!(urldecode("plain"), "plain");
    }

    #[test]
    fn is_token_expired_empty() {
        assert!(is_token_expired(""));
    }

    #[test]
    fn is_token_expired_invalid() {
        assert!(is_token_expired("not-a-date"));
    }

    #[test]
    fn is_token_expired_future() {
        let future = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(!is_token_expired(&future));
    }

    #[test]
    fn is_token_expired_past() {
        let past = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339();
        assert!(is_token_expired(&past));
    }

    #[test]
    fn is_token_expired_within_buffer() {
        // Token expires in 30 seconds — should be considered expired (60s buffer)
        let soon = (chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339();
        assert!(is_token_expired(&soon));
    }
}
