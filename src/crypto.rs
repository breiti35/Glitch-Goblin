//! Encrypt/decrypt the Bug-Sync API token using ChaCha20-Poly1305.
//!
//! Key derivation:
//!   v3 – PBKDF2-HMAC-SHA256(machine_id, "glitch-goblin-v3-kdf", 100_000 rounds) → 32 bytes
//!   v2 – PBKDF2-HMAC-SHA256(machine_id, "kanban-runner-v2-kdf", 100_000 rounds)  [legacy, decrypt-only]
//!   v1 – SHA-256(machine_id || "kanban-runner-v1")  [legacy, read-only for migration]
//!
//! Token formats:
//!   "v2:<12-byte nonce hex>:<ciphertext hex>"
//!   "v1:<12-byte nonce hex>: <ciphertext hex>"  [legacy]
//!   no prefix → plaintext (very old tokens, returned as-is)
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use pbkdf2::pbkdf2_hmac;
use sha2::{Digest, Sha256};

const PREFIX_V1: &str = "v1:";
const PREFIX_V2: &str = "v2:";
const PREFIX_V3: &str = "v3:";

/// PBKDF2 iteration count – slows brute-force attacks on a stolen config file
/// while remaining imperceptible during the single encrypt/decrypt call at startup.
const PBKDF2_ROUNDS: u32 = 100_000;
const KDF_SALT_V2: &[u8] = b"kanban-runner-v2-kdf";
const KDF_SALT: &[u8] = b"glitch-goblin-v3-kdf";

// ── Machine ID ───────────────────────────────────────────────────────────────

fn get_machine_id() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(id) = std::fs::read_to_string("/etc/machine-id") {
            let id = id.trim().to_string();
            if !id.is_empty() {
                return id;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(id) = get_macos_uuid() {
            return id;
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(id) = get_windows_machine_guid() {
            return id;
        }
    }

    get_or_create_fallback_seed()
}

#[cfg(target_os = "macos")]
fn get_macos_uuid() -> Result<String, String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            if let Some((_, rhs)) = line.split_once('=') {
                let uuid = rhs.trim().trim_matches('"').to_string();
                if !uuid.is_empty() {
                    return Ok(uuid);
                }
            }
        }
    }
    Err("IOPlatformUUID not found".to_string())
}

#[cfg(target_os = "windows")]
fn get_windows_machine_guid() -> Result<String, String> {
    let output = std::process::Command::new("reg")
        .args([
            "query",
            r"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("MachineGuid") {
            if let Some(guid) = line.split_whitespace().last() {
                return Ok(guid.to_string());
            }
        }
    }
    Err("MachineGuid not found".to_string())
}

/// Read or create a per-installation random seed stored in the app config dir.
/// Used as a fallback when the platform machine-id cannot be obtained.
fn get_or_create_fallback_seed() -> String {
    let Some(config_dir) = dirs::config_dir() else {
        // Absolute last resort: not persisted, changes every process start.
        return uuid::Uuid::new_v4().to_string();
    };
    let seed_path = config_dir.join("glitch-goblin").join("machine-seed.txt");
    // Also check old location for backward compat
    let old_seed_path = config_dir.join("kanban-runner").join("machine-seed.txt");
    if let Ok(seed) = std::fs::read_to_string(&seed_path) {
        let seed = seed.trim().to_string();
        if !seed.is_empty() {
            return seed;
        }
    }
    if let Ok(seed) = std::fs::read_to_string(&old_seed_path) {
        let seed = seed.trim().to_string();
        if !seed.is_empty() {
            return seed;
        }
    }
    let new_seed = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(config_dir.join("glitch-goblin"));
    write_seed_restricted(&seed_path, &new_seed);
    new_seed
}

/// Write `content` to `path` with owner-only permissions (0600 on Unix).
/// Errors are silently ignored — a failed write means the seed is ephemeral
/// for this process start (logged to stderr so token loss is detectable).
fn write_seed_restricted(path: &std::path::Path, content: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut f) => {
                if f.write_all(content.as_bytes()).is_err() {
                    eprintln!(
                        "[glitch-goblin] WARN: could not write machine-seed.txt — \
                         encrypted tokens will be unreadable after restart"
                    );
                }
            }
            Err(e) => {
                eprintln!(
                    "[glitch-goblin] WARN: could not create machine-seed.txt ({e}) — \
                     encrypted tokens will be unreadable after restart"
                );
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(path, content);
    }
}

// ── Key derivation ───────────────────────────────────────────────────────────

/// v3: PBKDF2-HMAC-SHA256 with new salt (glitch-goblin).
fn derive_key_v3(machine_id: &str) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(machine_id.as_bytes(), KDF_SALT, PBKDF2_ROUNDS, &mut key);
    key
}

/// v2: PBKDF2-HMAC-SHA256 with old salt (kanban-runner) – kept for decrypting legacy tokens.
fn derive_key_v2(machine_id: &str) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(machine_id.as_bytes(), KDF_SALT_V2, PBKDF2_ROUNDS, &mut key);
    key
}

/// v1: SHA-256(machine_id || salt) – kept only for decrypting legacy tokens.
fn derive_key_v1() -> [u8; 32] {
    let machine_id = std::fs::read_to_string("/etc/machine-id")
        .unwrap_or_else(|_| "kanban-runner-fallback-key-static".to_string());
    let mut hasher = Sha256::new();
    hasher.update(machine_id.trim().as_bytes());
    hasher.update(b"kanban-runner-v1");
    hasher.finalize().into()
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Encrypt `plaintext` and return a `"v3:<nonce_hex>:<ciphertext_hex>"` string.
///
/// Already-encrypted tokens (`v1:`, `v2:`, or `v3:` prefix) are returned unchanged.
pub fn encrypt_token(plaintext: &str) -> Result<String, String> {
    if plaintext.starts_with(PREFIX_V1)
        || plaintext.starts_with(PREFIX_V2)
        || plaintext.starts_with(PREFIX_V3)
    {
        return Ok(plaintext.to_string());
    }
    let key = derive_key_v3(&get_machine_id());
    let cipher = ChaCha20Poly1305::new(&key.into());
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("Verschlüsselung fehlgeschlagen: {e}"))?;
    Ok(format!(
        "{}{}:{}",
        PREFIX_V3,
        hex::encode(nonce.as_slice()),
        hex::encode(&ciphertext)
    ))
}

/// Decrypt a token produced by `encrypt_token`.
///
/// * `v3:` tokens are decrypted with PBKDF2-derived key (glitch-goblin salt).
/// * `v2:` tokens are decrypted with PBKDF2-derived key (kanban-runner salt).
/// * `v1:` tokens are decrypted with the legacy SHA-256-derived key.
/// * Tokens without a prefix are returned as plaintext (backward compat).
pub fn decrypt_token(encrypted: &str) -> Result<String, String> {
    if let Some(rest) = encrypted.strip_prefix(PREFIX_V3) {
        return decrypt_v3(rest);
    }
    if let Some(rest) = encrypted.strip_prefix(PREFIX_V2) {
        return decrypt_v2(rest);
    }
    if let Some(rest) = encrypted.strip_prefix(PREFIX_V1) {
        return decrypt_v1(rest);
    }
    Ok(encrypted.to_string())
}

fn decrypt_v3(rest: &str) -> Result<String, String> {
    let (nonce_hex, cipher_hex) = rest
        .split_once(':')
        .ok_or_else(|| "Ungültiges v3-Token-Format (kein Trennzeichen)".to_string())?;
    chacha_decrypt(nonce_hex, cipher_hex, derive_key_v3(&get_machine_id()))
}

fn decrypt_v2(rest: &str) -> Result<String, String> {
    let (nonce_hex, cipher_hex) = rest
        .split_once(':')
        .ok_or_else(|| "Ungültiges v2-Token-Format (kein Trennzeichen)".to_string())?;
    chacha_decrypt(nonce_hex, cipher_hex, derive_key_v2(&get_machine_id()))
}

fn decrypt_v1(rest: &str) -> Result<String, String> {
    // v1 used ": " (colon + space) as separator
    let mut parts = rest.splitn(2, ": ");
    let nonce_hex = parts
        .next()
        .ok_or_else(|| "Ungültiges v1-Token-Format (kein Nonce)".to_string())?;
    let cipher_hex = parts
        .next()
        .ok_or_else(|| "Ungültiges v1-Token-Format (kein Ciphertext)".to_string())?;
    chacha_decrypt(nonce_hex, cipher_hex, derive_key_v1())
}

fn chacha_decrypt(nonce_hex: &str, cipher_hex: &str, key: [u8; 32]) -> Result<String, String> {
    let nonce_bytes =
        hex::decode(nonce_hex).map_err(|e| format!("Ungültiger Nonce (hex): {e}"))?;
    let cipher_bytes =
        hex::decode(cipher_hex).map_err(|e| format!("Ungültiger Ciphertext (hex): {e}"))?;

    if nonce_bytes.len() != 12 {
        return Err(format!(
            "Ungültige Nonce-Länge: {} Bytes (erwartet 12)",
            nonce_bytes.len()
        ));
    }

    let cipher = ChaCha20Poly1305::new(&key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, cipher_bytes.as_slice())
        .map_err(|_| {
            "Entschlüsselung fehlgeschlagen (falscher Schlüssel oder beschädigte Daten)"
                .to_string()
        })?;

    String::from_utf8(plaintext)
        .map_err(|e| format!("Entschlüsselter Token ist kein gültiges UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_v3() {
        let token = "my-secret-api-token";
        let encrypted = encrypt_token(token).unwrap();
        assert!(encrypted.starts_with("v3:"), "Expected v3 prefix, got: {}", &encrypted[..6.min(encrypted.len())]);
        let decrypted = decrypt_token(&encrypted).unwrap();
        assert_eq!(decrypted, token);
    }

    #[test]
    fn no_double_encrypt() {
        let token = "plain";
        let enc1 = encrypt_token(token).unwrap();
        let enc2 = encrypt_token(&enc1).unwrap();
        assert_eq!(enc1, enc2);
    }

    #[test]
    fn plaintext_passthrough() {
        let token = "no-prefix-token";
        assert_eq!(decrypt_token(token).unwrap(), token);
    }

    #[test]
    fn different_nonce_each_time() {
        let token = "secret";
        let enc1 = encrypt_token(token).unwrap();
        let enc2 = encrypt_token(token).unwrap();
        // Same plaintext should produce different ciphertexts (different nonces)
        assert_ne!(enc1, enc2);
        assert_eq!(decrypt_token(&enc1).unwrap(), token);
        assert_eq!(decrypt_token(&enc2).unwrap(), token);
    }
}
