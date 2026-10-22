import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Authenticated symmetric encryption for secrets at rest — the TOTP shared
 * secret (0058), and anything else that must be stored reversibly rather than
 * hashed.
 *
 * AES-256-GCM: GCM authenticates the ciphertext, so a tampered row fails to
 * decrypt rather than returning garbage. The stored form is base64 of
 * `iv(12) | tag(16) | ciphertext`, so one column holds everything needed to
 * decrypt except the key — which lives only in MFA_ENCRYPTION_KEY, never in the
 * database or the bundle.
 *
 * The key is accepted as 64 hex chars (32 bytes) or base64; `deriveKey` also
 * accepts a longer passphrase and folds it to 32 bytes with SHA-256 so a
 * generated `openssl rand -hex 32` works directly and a human-typed phrase
 * still yields a valid key rather than throwing.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

function deriveKey(rawKey: string): Buffer {
  const trimmed = (rawKey ?? '').trim();
  if (!trimmed) {
    throw new Error('secret-box: encryption key is empty');
  }
  // Exactly 32 bytes as hex or base64 is used verbatim; anything else is
  // hashed to 32 bytes so a passphrase of any length is still a valid key.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  const asBase64 = Buffer.from(trimmed, 'base64');
  if (asBase64.length === 32) return asBase64;
  return createHash('sha256').update(trimmed).digest();
}

/** Encrypt a plaintext string. Returns base64(iv | tag | ciphertext). */
export function encryptSecret(plaintext: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Decrypt what `encryptSecret` produced. Throws on a wrong key or tampering. */
export function decryptSecret(stored: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/** SHA-256 hex of a recovery code — high-entropy, so a fast hash is correct. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}
