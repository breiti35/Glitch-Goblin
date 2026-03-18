/// Encrypt/decrypt the Bug-Sync API token using ChaCha20-Poly1305.
///
/// Key derivation: SHA-256( /etc/machine-id || "kanban-runner-v1" )
/// Format:         "v1:<12-byte nonce as hex>:<ciphertext as hex>"
/// Backward-compat: tokens without the "v1:" prefix are treated as plaintext
///                  and returned unchanged (migration path).
use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    ChaCha20Poly1305, Nonce,
};
use sha2::{Digest, Sha256};

const PREFIX: &str = "v1:";

fn derive_key() -> [u8; 32] {
    let machine_id = std::fs::read_to_string("/etc/machine-id")
        .unwrap_or_else(|_| "kanban-runner-fallback-key-static".to_string());
    let machine_id = machine_id.trim();
    let salt = b"kanban-runner-v1";
    let mut hasher = Sha256::new();
    hasher.update(machine_id.as_bytes());
    hasher.update(salt);
    hasher.finalize().into()
}

/// Encrypt `plaintext` and return `"v1:<nonce_hex>:<ciphertext_hex>"`.
pub fn encrypt_token(plaintext: &str) -> Result<String, String> {
    // Already encrypted — do not double-encrypt
    if plaintext.starts_with(PREFIX) {
        return Ok(plaintext.to_string());
    }
    let key = derive_key();
    let cipher = ChaCha20Poly1305::new(&key.into());
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("Verschlüsselung fehlgeschlagen: {e}"))?;
    Ok(format!(
        "{}{}: {}",
        PREFIX,
        hex::encode(nonce.as_slice()),
        hex::encode(&ciphertext)
    ))
}

/// Decrypt a token encrypted by `encrypt_token`.
///
/// If the input does not start with `"v1:"` it is assumed to be plaintext
/// (backward-compatible migration path) and is returned as-is.
pub fn decrypt_token(encrypted: &str) -> Result<String, String> {
    if !encrypted.starts_with(PREFIX) {
        // Plaintext from before encryption was introduced
        return Ok(encrypted.to_string());
    }
    let rest = &encrypted[PREFIX.len()..];
    let mut parts = rest.splitn(2, ": ");
    let nonce_hex = parts
        .next()
        .ok_or_else(|| "Ungültiges Token-Format (kein Nonce)".to_string())?;
    let cipher_hex = parts
        .next()
        .ok_or_else(|| "Ungültiges Token-Format (kein Ciphertext)".to_string())?;

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

    let key = derive_key();
    let cipher = ChaCha20Poly1305::new(&key.into());
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, cipher_bytes.as_slice())
        .map_err(|_| "Entschlüsselung fehlgeschlagen (falscher Schlüssel oder beschädigte Daten)"
            .to_string())?;

    String::from_utf8(plaintext)
        .map_err(|e| format!("Entschlüsselter Token ist kein gültiges UTF-8: {e}"))
}
