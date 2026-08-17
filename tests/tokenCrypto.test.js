const { test } = require("node:test");
const assert = require("node:assert/strict");

// A deterministic 32-byte test key (base64). NOT a real secret.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** Load a fresh copy of the module with TOKEN_ENC_KEY set to `key` (or unset). */
function loadCrypto(key) {
  delete require.cache[require.resolve("../src/install-kit/tokenCrypto")];
  if (key == null) delete process.env.TOKEN_ENC_KEY;
  else process.env.TOKEN_ENC_KEY = key;
  const mod = require("../src/install-kit/tokenCrypto");
  mod._resetKeyCache();
  return mod;
}

test("round-trips a token when a key is configured", () => {
  const { encrypt, decrypt, isEncrypted } = loadCrypto(TEST_KEY);
  const token = "xoxb-1234567890-abcdefabcdef";
  const enc = encrypt(token);
  assert.ok(isEncrypted(enc), "ciphertext carries the enc:v1: prefix");
  assert.notEqual(enc, token, "stored value is not the plaintext");
  assert.equal(decrypt(enc), token, "decrypts back to the original");
});

test("ciphertext differs each call (random IV) but both decrypt", () => {
  const { encrypt, decrypt } = loadCrypto(TEST_KEY);
  const token = "xoxp-secret-user-token";
  const a = encrypt(token);
  const b = encrypt(token);
  assert.notEqual(a, b, "distinct IVs → distinct ciphertext");
  assert.equal(decrypt(a), token);
  assert.equal(decrypt(b), token);
});

test("decrypt passes through legacy plaintext (no prefix) unchanged", () => {
  const { decrypt } = loadCrypto(TEST_KEY);
  assert.equal(decrypt("xoxb-legacy-plaintext"), "xoxb-legacy-plaintext");
});

test("encrypt is idempotent — already-encrypted value is returned as-is", () => {
  const { encrypt } = loadCrypto(TEST_KEY);
  const enc = encrypt("xoxb-abc");
  assert.equal(encrypt(enc), enc, "does not double-encrypt");
});

test("nullish / empty values pass through both ways", () => {
  const { encrypt, decrypt } = loadCrypto(TEST_KEY);
  for (const v of [null, undefined, ""]) {
    assert.equal(encrypt(v), v);
    assert.equal(decrypt(v), v);
  }
});

test("without a key, encrypt is a no-op (plaintext) and decrypt returns plaintext", () => {
  const { encrypt, decrypt, isEncrypted, encryptionEnabled } = loadCrypto(null);
  assert.equal(encryptionEnabled(), false);
  const token = "xoxb-no-key-set";
  const enc = encrypt(token);
  assert.equal(enc, token, "no key → stored in plaintext");
  assert.ok(!isEncrypted(enc));
  assert.equal(decrypt(token), token);
});

test("decrypting an encrypted value with no key throws (integrity signal)", () => {
  const { encrypt } = loadCrypto(TEST_KEY);
  const enc = encrypt("xoxb-abc");
  const { decrypt } = loadCrypto(null);
  assert.throws(() => decrypt(enc), /TOKEN_ENC_KEY is not set/);
});

test("decrypting with the wrong key throws (GCM auth failure)", () => {
  const { encrypt } = loadCrypto(TEST_KEY);
  const enc = encrypt("xoxb-abc");
  const { decrypt } = loadCrypto(Buffer.alloc(32, 9).toString("base64"));
  assert.throws(() => decrypt(enc));
});

test("tampered ciphertext fails authentication", () => {
  const { encrypt, decrypt } = loadCrypto(TEST_KEY);
  const enc = encrypt("xoxb-abc");
  // Flip a character in the base64 body.
  const body = enc.slice("enc:v1:".length);
  const flipped = (body[0] === "A" ? "B" : "A") + body.slice(1);
  assert.throws(() => decrypt("enc:v1:" + flipped));
});

test("accepts a hex-encoded key", () => {
  const hexKey = Buffer.alloc(32, 3).toString("hex");
  const { encrypt, decrypt } = loadCrypto(hexKey);
  const token = "xoxb-hex-key";
  assert.equal(decrypt(encrypt(token)), token);
});

test("rejects a key that is not 32 bytes", () => {
  assert.throws(() => {
    const { encrypt } = loadCrypto(Buffer.alloc(16, 1).toString("base64"));
    encrypt("x"); // getKey() is lazy — force resolution
  }, /32 bytes/);
});

// ---- Fix 1 (security review): a malformed key must fail LOUD on EVERY call ----
// Regression for the cache-poisoning bug: getKey() set _keyResolved=true before
// validating, so the first call threw but every later call returned null — and
// encrypt() then treated a MALFORMED key as "no key" and silently persisted the
// OAuth token in PLAINTEXT. A set-but-bad key must never downgrade to plaintext.
test("Fix 1: a malformed key throws on every call and NEVER stores plaintext", () => {
  const { encrypt, decrypt, encryptionEnabled } = loadCrypto(
    Buffer.alloc(20, 1).toString("base64"), // decodes to 20 bytes, not 32
  );
  const token = "xoxb-must-not-leak-in-plaintext";

  // First call throws (loud failure) …
  assert.throws(() => encrypt(token), /32 bytes/, "first encrypt throws");
  // … and so does the SECOND, THIRD, … (no silent downgrade to plaintext).
  assert.throws(() => encrypt(token), /32 bytes/, "second encrypt still throws");
  assert.throws(() => encrypt(token), /32 bytes/, "third encrypt still throws");
  // The token value never comes back out unencrypted from encrypt().
  let leaked = null;
  try { leaked = encrypt(token); } catch (_) {}
  assert.notEqual(leaked, token, "malformed key must never return the plaintext token");
  // Decrypt and the enabled probe also fail loud rather than reporting "off".
  assert.throws(() => decrypt("enc:v1:whatever"), /32 bytes/);
  assert.throws(() => encryptionEnabled(), /32 bytes/);
});
