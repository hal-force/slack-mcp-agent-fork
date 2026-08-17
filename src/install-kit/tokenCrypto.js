/**
 * Encrypt/decrypt OAuth tokens at rest (AES-256-GCM).
 *
 * The Installation table holds live Slack bot (`xoxb-`) and user (`xoxp-`)
 * tokens. Storing them in cleartext means anyone who can read the DB — a leaked
 * DATABASE_URL, a Postgres backup/follower, a support export — gets tokens that
 * impersonate the bot and every installing user. This module wraps token values
 * so the stored bytes are useless without the app-held key.
 *
 * Key: TOKEN_ENC_KEY — 32 bytes, provided base64 or hex (a raw 32-char string is
 * also accepted). Generate one with:  openssl rand -base64 32
 *
 * Format of an encrypted value:  enc:v1:<base64( iv(12) || authTag(16) || ciphertext )>
 *
 * Backward/forward compatibility:
 *  - decrypt() returns any value NOT starting with the "enc:v1:" prefix
 *    unchanged, so pre-existing plaintext rows keep working and a key rollout is
 *    seamless (rows re-encrypt the next time they're written).
 *  - When no key is configured, encrypt() is a no-op (stores plaintext) and logs
 *    a one-time warning, so local/dev without a key still runs. Set the key in
 *    production (Heroku config var) to actually protect tokens.
 */

const crypto = require("crypto");

const PREFIX = "enc:v1:";
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

let _keyResolved = false;
let _key = null; // Buffer(32) or null
let _warnedNoKey = false;

/**
 * Resolve the 32-byte key from TOKEN_ENC_KEY (base64 / hex / raw). Cached.
 * @returns {Buffer|null}
 */
function getKey() {
  if (_keyResolved) return _key;
  const raw = String(process.env.TOKEN_ENC_KEY || "").trim();
  if (!raw) {
    // No key configured: cache the "disabled" state (a legit, stable config).
    _keyResolved = true;
    _key = null;
    return _key;
  }
  let buf = null;
  // Try base64, then hex, then raw utf8 — accept whichever yields 32 bytes.
  try {
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) buf = b64;
  } catch (_) {}
  if (!buf && /^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  }
  if (!buf && Buffer.byteLength(raw, "utf8") === 32) {
    buf = Buffer.from(raw, "utf8");
  }
  if (!buf || buf.length !== 32) {
    // A key IS set but is malformed. Do NOT cache this state — leaving
    // _keyResolved false makes every subsequent call re-enter and throw again.
    // Caching here would return null on later calls, and encrypt() would then
    // treat "malformed key" as "no key" and silently persist tokens in
    // PLAINTEXT. Fail loud, consistently, on every call instead.
    throw new Error(
      "TOKEN_ENC_KEY must decode to exactly 32 bytes (base64 or hex). Generate with: openssl rand -base64 32",
    );
  }
  // Cache only on success.
  _keyResolved = true;
  _key = buf;
  return _key;
}

/** @param {unknown} v */
function isEncrypted(v) {
  return typeof v === "string" && v.startsWith(PREFIX);
}

/**
 * Encrypt a token string. No-op (returns input) for empty/nullish values or when
 * no key is configured. Idempotent: an already-encrypted value is returned as-is.
 * @param {string|null|undefined} plaintext
 * @returns {string|null|undefined}
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === "") return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const key = getKey();
  if (!key) {
    if (!_warnedNoKey) {
      _warnedNoKey = true;
      console.warn(
        "[tokenCrypto] TOKEN_ENC_KEY is not set — OAuth tokens are being stored in PLAINTEXT. Set TOKEN_ENC_KEY (openssl rand -base64 32) in production.",
      );
    }
    return plaintext;
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt a value produced by encrypt(). Returns non-prefixed values unchanged
 * (legacy plaintext). Throws only if a prefixed value is malformed or the key is
 * missing/wrong — a real integrity signal, not something to swallow silently.
 * @param {string|null|undefined} stored
 * @returns {string|null|undefined}
 */
function decrypt(stored) {
  if (stored == null || stored === "") return stored;
  if (!isEncrypted(stored)) return stored; // legacy plaintext row
  const key = getKey();
  if (!key) {
    throw new Error(
      "[tokenCrypto] Found an encrypted token but TOKEN_ENC_KEY is not set — cannot decrypt.",
    );
  }
  const blob = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("[tokenCrypto] Encrypted token is malformed (too short).");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True when a usable encryption key is configured. */
function encryptionEnabled() {
  return getKey() != null;
}

/** Test seam: forget the cached key so a changed env var takes effect. */
function _resetKeyCache() {
  _keyResolved = false;
  _key = null;
  _warnedNoKey = false;
}

module.exports = { encrypt, decrypt, isEncrypted, encryptionEnabled, _resetKeyCache };
