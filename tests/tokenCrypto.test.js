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

// ---- Fix (security review): fail-closed encryption via REQUIRE_TOKEN_ENC ----
// In production a missing TOKEN_ENC_KEY should be a LOUD, blocking error rather
// than a silent downgrade to storing live OAuth tokens in cleartext. Opt-in so
// the local/dev no-key path is unchanged by default.

/** Load the module with TOKEN_ENC_KEY and REQUIRE_TOKEN_ENC both controlled. */
function loadCryptoRequire(key, requireVal) {
  if (requireVal == null) delete process.env.REQUIRE_TOKEN_ENC;
  else process.env.REQUIRE_TOKEN_ENC = requireVal;
  return loadCrypto(key);
}

test("requireEncryption() reads REQUIRE_TOKEN_ENC (1/true/yes on; else off)", () => {
  try {
    for (const on of ["1", "true", "TRUE", "yes", "Yes"]) {
      const { requireEncryption } = loadCryptoRequire(null, on);
      assert.equal(requireEncryption(), true, `${on} → on`);
    }
    for (const off of ["0", "false", "no", "", "maybe"]) {
      const { requireEncryption } = loadCryptoRequire(null, off);
      assert.equal(requireEncryption(), false, `${JSON.stringify(off)} → off`);
    }
    const { requireEncryption } = loadCryptoRequire(null, null); // unset
    assert.equal(requireEncryption(), false, "unset → off");
  } finally {
    delete process.env.REQUIRE_TOKEN_ENC;
  }
});

test("REQUIRE_TOKEN_ENC=1 with no key: encrypt throws instead of storing plaintext", () => {
  try {
    const { encrypt } = loadCryptoRequire(null, "1");
    const token = "xoxb-must-fail-closed";
    assert.throws(
      () => encrypt(token),
      /REQUIRE_TOKEN_ENC=1 but TOKEN_ENC_KEY is not set/,
      "fail closed: no silent plaintext persist",
    );
    // Nullish/empty still pass through — nothing sensitive to protect.
    assert.equal(encrypt(""), "");
    assert.equal(encrypt(null), null);
  } finally {
    delete process.env.REQUIRE_TOKEN_ENC;
  }
});

test("REQUIRE_TOKEN_ENC=1 WITH a valid key still round-trips (enforcement is a no-op)", () => {
  try {
    const { encrypt, decrypt, isEncrypted } = loadCryptoRequire(TEST_KEY, "1");
    const token = "xoxb-encrypted-under-enforcement";
    const enc = encrypt(token);
    assert.ok(isEncrypted(enc));
    assert.equal(decrypt(enc), token);
  } finally {
    delete process.env.REQUIRE_TOKEN_ENC;
  }
});

test("default (REQUIRE_TOKEN_ENC unset) with no key preserves the plaintext no-op path", () => {
  const { encrypt } = loadCryptoRequire(null, null);
  const token = "xoxb-dev-no-key";
  assert.equal(encrypt(token), token, "unchanged legacy dev behavior");
});
