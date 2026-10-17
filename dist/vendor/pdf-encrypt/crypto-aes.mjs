/**
 * AES-256 cryptographic utilities for PDF encryption (R=6)
 * Uses Web Crypto API — works in browsers, Cloudflare Workers, Deno, Node 18+
 *
 * @author PDFSmaller.com (https://pdfsmaller.com)
 * @license MIT
 *
 * Implements Algorithm 2.B from ISO 32000-2:2020
 * Verified against mozilla/pdf.js (the reference implementation)
 */

/**
 * Concatenate multiple Uint8Arrays
 */
export function concat(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ========== SHA Hash Functions (Web Crypto) ==========

export async function sha256(data) {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(hash);
}

export async function sha384(data) {
  const hash = await crypto.subtle.digest('SHA-384', data);
  return new Uint8Array(hash);
}

export async function sha512(data) {
  const hash = await crypto.subtle.digest('SHA-512', data);
  return new Uint8Array(hash);
}

// ========== AES Encryption (Web Crypto) ==========

/**
 * AES-128-CBC encrypt (for Algorithm 2.B intermediate step)
 * Strips PKCS#7 padding since input is always block-aligned
 */
export async function aes128CbcEncrypt(data, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  // Strip PKCS#7 padding block (data is always block-aligned in Algorithm 2.B)
  return new Uint8Array(encrypted).slice(0, data.byteLength);
}

/**
 * AES-256-CBC encrypt with PKCS#7 padding (for per-object encryption)
 * Returns full ciphertext including padding
 */
export async function aes256CbcEncrypt(data, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(encrypted);
}

/**
 * AES-256-CBC encrypt, strip padding (for UE, OE where input is block-aligned)
 */
export async function aes256CbcEncryptNoPad(data, key, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(encrypted).slice(0, data.byteLength);
}

/**
 * AES-256-ECB encrypt a single 16-byte block (for Perms computation)
 * Uses CBC with zero IV — identical to ECB for a single block
 */
export async function aes256EcbEncryptBlock(block, key) {
  const iv = new Uint8Array(16); // zero IV
  const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, block);
  return new Uint8Array(encrypted).slice(0, 16);
}

/**
 * Import an AES-256 key for reuse across multiple encrypt operations
 */
export async function importAES256Key(key) {
  return await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
}

/**
 * AES-256-CBC encrypt using a pre-imported CryptoKey (for per-object encryption)
 */
export async function aes256CbcEncryptWithKey(data, cryptoKey, iv) {
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(encrypted);
}

// ========== Algorithm 2.B (ISO 32000-2:2020) ==========

/**
 * Algorithm 2.B — Computing a hash for R=6
 *
 * This is the hardened key derivation function used by PDF 2.0 (AES-256).
 * Iterates SHA-256/384/512 + AES-128-CBC for at least 64 rounds.
 *
 * Verified against mozilla/pdf.js (PDF20._hash)
 *
 * @param {Uint8Array} password - UTF-8 password bytes (max 127)
 * @param {Uint8Array} salt - 8-byte salt
 * @param {Uint8Array} userKey - 48-byte U value (for owner ops) or empty
 * @returns {Promise<Uint8Array>} - 32-byte hash
 */
export async function computeHash2B(password, salt, userKey) {
  // Step 1: Initial SHA-256 hash
  const input = concat(password, salt, userKey);
  let K = await sha256(input);

  // Step 2: Iterative loop (minimum 64 rounds)
  let i = 0;
  let E;

  while (true) {
    // Step 2a: K1 = (password + K + userKey) repeated 64 times
    const block = concat(password, K, userKey);
    const K1 = new Uint8Array(block.length * 64);
    for (let j = 0; j < 64; j++) {
      K1.set(block, j * block.length);
    }

    // Step 2b: AES-128-CBC encrypt K1
    // Key = K[0..15], IV = K[16..31]
    const aesKey = K.slice(0, 16);
    const aesIV = K.slice(16, 32);
    E = await aes128CbcEncrypt(K1, aesKey, aesIV);

    // Step 2c: Hash function selection
    // Sum first 16 bytes of E mod 3 (equivalent to 128-bit big-endian mod 3)
    let byteSum = 0;
    for (let j = 0; j < 16; j++) {
      byteSum += E[j];
    }
    const hashSelect = byteSum % 3;

    // Step 2d: Hash E with selected function
    if (hashSelect === 0) {
      K = await sha256(E);
    } else if (hashSelect === 1) {
      K = await sha384(E);
    } else {
      K = await sha512(E);
    }

    // Step 2e: Termination (per pdf.js: while i < 64 || E[-1] > i - 32)
    i++;
    if (i >= 64 && E[E.length - 1] <= i - 32) {
      break;
    }
  }

  return K.slice(0, 32);
}
