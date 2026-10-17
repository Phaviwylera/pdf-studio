/**
 * @pdfsmaller/pdf-encrypt — PDF encryption with AES-256 and RC4 support
 * Powers PDFSmaller.com's Protect PDF tool
 *
 * @author PDFSmaller.com (https://pdfsmaller.com)
 * @license MIT
 * @see https://pdfsmaller.com/protect-pdf - Try it online!
 *
 * Implements:
 *   - AES-256 (V=5, R=6) per ISO 32000-2:2020 — Algorithms 2.B, 8, 9, 10
 *   - RC4 128-bit (V=2, R=3) per ISO 32000-1:2008 — Algorithms 2, 3, 4
 *
 * Verified against mozilla/pdf.js and Adobe Acrobat
 */

// Browser no-build adaptation: pdf-lib is preloaded as the global PDFLib UMD bundle.
const { PDFDocument, PDFName, PDFHexString, PDFString, PDFDict, PDFArray, PDFRawStream, PDFNumber } = globalThis.PDFLib;
import { md5, RC4, bytesToHex } from './crypto-rc4.mjs';
import {
  sha256, sha384, sha512,
  aes256CbcEncrypt, aes256CbcEncryptNoPad, aes256EcbEncryptBlock,
  importAES256Key, aes256CbcEncryptWithKey,
  computeHash2B, concat
} from './crypto-aes.mjs';
import {
  encodePasswordLegacy, encodePasswordAES256, PasswordEncodingError
} from './password-encoding.mjs';

/**
 * Thrown when the input PDF already has an /Encrypt dictionary.
 *
 * pdf-lib cannot decrypt, so `ignoreEncryption: true` hands us the *ciphertext*
 * as if it were plaintext object data. Encrypting that again produces a file
 * that opens with the new password but whose every stream and string is still
 * encrypted under a key nobody has. Fail loudly instead.
 */
export class AlreadyEncryptedError extends Error {
  constructor() {
    super(
      'This PDF is already password-protected. Remove the existing protection ' +
      'before applying new encryption.'
    );
    this.name = 'AlreadyEncryptedError';
    this.code = 'ALREADY_ENCRYPTED';
  }
}

export { PasswordEncodingError };

/** Errors that describe a caller mistake and must reach the caller unwrapped. */
function isCallerError(error) {
  return error instanceof AlreadyEncryptedError || error instanceof PasswordEncodingError;
}

// ========== PDF Standard Padding (for RC4) ==========

const PADDING = new Uint8Array([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
  0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
  0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

// ========== Permission Flags (ISO 32000-2 Table 22) ==========

const PERM_FLAGS = {
  PRINT:              0x00000004, // Bit 3
  MODIFY:             0x00000008, // Bit 4
  COPY:               0x00000010, // Bit 5
  ANNOTATE:           0x00000020, // Bit 6
  FILL_FORMS:         0x00000100, // Bit 9
  EXTRACT:            0x00000200, // Bit 10
  ASSEMBLE:           0x00000400, // Bit 11
  PRINT_HIGH_QUALITY: 0x00000800, // Bit 12
};

/**
 * Build 32-bit permission integer from options
 * Bits 1-2, 7-8, 13-32 must be set to 1 per spec
 */
function buildPermissions(options) {
  // Start with required bits set (1-2 set, 7-8 set, 13-32 set)
  let P = 0xFFFFF000 | 0x000000C0; // bits 13-32 + bits 7-8

  if (options.allowPrinting !== false) P |= PERM_FLAGS.PRINT;
  if (options.allowModifying !== false) P |= PERM_FLAGS.MODIFY;
  if (options.allowCopying !== false) P |= PERM_FLAGS.COPY;
  if (options.allowAnnotating !== false) P |= PERM_FLAGS.ANNOTATE;
  if (options.allowFillingForms !== false) P |= PERM_FLAGS.FILL_FORMS;
  if (options.allowExtraction !== false) P |= PERM_FLAGS.EXTRACT;
  if (options.allowAssembly !== false) P |= PERM_FLAGS.ASSEMBLE;
  if (options.allowHighQualityPrint !== false) P |= PERM_FLAGS.PRINT_HIGH_QUALITY;

  // Convert to signed 32-bit integer
  return P | 0;
}

// ========== RC4 Encryption (V=2, R=3) ==========

function padPassword(password) {
  // PDFDocEncoding, not UTF-8 — see password-encoding.js. UTF-8 here produced
  // files that no conforming reader could open with a non-ASCII password.
  const pwdBytes = encodePasswordLegacy(password);
  const padded = new Uint8Array(32);
  if (pwdBytes.length >= 32) {
    padded.set(pwdBytes.slice(0, 32));
  } else {
    padded.set(pwdBytes);
    padded.set(PADDING.slice(0, 32 - pwdBytes.length), pwdBytes.length);
  }
  return padded;
}

function computeEncryptionKeyRC4(userPassword, ownerKey, permissions, fileId) {
  const paddedPwd = padPassword(userPassword);
  const hashInput = new Uint8Array(paddedPwd.length + ownerKey.length + 4 + fileId.length);
  let offset = 0;
  hashInput.set(paddedPwd, offset); offset += paddedPwd.length;
  hashInput.set(ownerKey, offset); offset += ownerKey.length;
  hashInput[offset++] = permissions & 0xFF;
  hashInput[offset++] = (permissions >> 8) & 0xFF;
  hashInput[offset++] = (permissions >> 16) & 0xFF;
  hashInput[offset++] = (permissions >> 24) & 0xFF;
  hashInput.set(fileId, offset);
  let hash = md5(hashInput);
  for (let i = 0; i < 50; i++) {
    hash = md5(hash.slice(0, 16));
  }
  return hash.slice(0, 16);
}

function computeOwnerKeyRC4(ownerPassword, userPassword) {
  const paddedOwner = padPassword(ownerPassword || userPassword);
  let hash = md5(paddedOwner);
  for (let i = 0; i < 50; i++) {
    hash = md5(hash);
  }
  const paddedUser = padPassword(userPassword);
  let result = new Uint8Array(paddedUser);
  for (let i = 0; i < 20; i++) {
    const key = new Uint8Array(hash.length);
    for (let j = 0; j < hash.length; j++) {
      key[j] = hash[j] ^ i;
    }
    const rc4 = new RC4(key.slice(0, 16));
    result = rc4.process(result);
  }
  return result;
}

function computeUserKeyRC4(encryptionKey, fileId) {
  const hashInput = new Uint8Array(PADDING.length + fileId.length);
  hashInput.set(PADDING);
  hashInput.set(fileId, PADDING.length);
  const hash = md5(hashInput);
  const rc4 = new RC4(encryptionKey);
  let result = rc4.process(hash);
  for (let i = 1; i <= 19; i++) {
    const key = new Uint8Array(encryptionKey.length);
    for (let j = 0; j < encryptionKey.length; j++) {
      key[j] = encryptionKey[j] ^ i;
    }
    const rc4iter = new RC4(key);
    result = rc4iter.process(result);
  }
  const finalResult = new Uint8Array(32);
  finalResult.set(result);
  return finalResult;
}

function encryptObjectRC4(data, objectNum, generationNum, encryptionKey) {
  const keyInput = new Uint8Array(encryptionKey.length + 5);
  keyInput.set(encryptionKey);
  keyInput[encryptionKey.length] = objectNum & 0xFF;
  keyInput[encryptionKey.length + 1] = (objectNum >> 8) & 0xFF;
  keyInput[encryptionKey.length + 2] = (objectNum >> 16) & 0xFF;
  keyInput[encryptionKey.length + 3] = generationNum & 0xFF;
  keyInput[encryptionKey.length + 4] = (generationNum >> 8) & 0xFF;
  const objectKey = md5(keyInput);
  const rc4 = new RC4(objectKey.slice(0, Math.min(encryptionKey.length + 5, 16)));
  return rc4.process(data);
}

// ========== AES-256 Encryption (V=5, R=6) ==========

/**
 * Generate cryptographically random bytes
 */
function randomBytes(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Algorithm 8 — Computing U and UE (ISO 32000-2:2020)
 *
 * @param {Uint8Array} password - UTF-8 password bytes (max 127)
 * @param {Uint8Array} fileKey - 32-byte random file encryption key
 * @returns {Promise<{U: Uint8Array, UE: Uint8Array}>}
 */
async function computeUandUE(password, fileKey) {
  // Generate random validation salt (8 bytes) and key salt (8 bytes)
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);

  // U = hash(password, validationSalt) + validationSalt + keySalt
  const hash = await computeHash2B(password, validationSalt, new Uint8Array(0));
  const U = new Uint8Array(48);
  U.set(hash, 0);          // 32-byte hash
  U.set(validationSalt, 32); // 8-byte validation salt
  U.set(keySalt, 40);       // 8-byte key salt

  // UE = AES-256-CBC(fileKey, key=hash2B(password, keySalt), iv=zero)
  const ueKey = await computeHash2B(password, keySalt, new Uint8Array(0));
  const zeroIV = new Uint8Array(16);
  const UE = await aes256CbcEncryptNoPad(fileKey, ueKey, zeroIV);

  return { U, UE };
}

/**
 * Algorithm 9 — Computing O and OE (ISO 32000-2:2020)
 *
 * @param {Uint8Array} password - Owner password bytes (max 127)
 * @param {Uint8Array} fileKey - 32-byte random file encryption key
 * @param {Uint8Array} U - 48-byte U value (from Algorithm 8)
 * @returns {Promise<{O: Uint8Array, OE: Uint8Array}>}
 */
async function computeOandOE(password, fileKey, U) {
  const validationSalt = randomBytes(8);
  const keySalt = randomBytes(8);

  // O = hash(password, validationSalt, U) + validationSalt + keySalt
  const hash = await computeHash2B(password, validationSalt, U);
  const O = new Uint8Array(48);
  O.set(hash, 0);
  O.set(validationSalt, 32);
  O.set(keySalt, 40);

  // OE = AES-256-CBC(fileKey, key=hash2B(password, keySalt, U), iv=zero)
  const oeKey = await computeHash2B(password, keySalt, U);
  const zeroIV = new Uint8Array(16);
  const OE = await aes256CbcEncryptNoPad(fileKey, oeKey, zeroIV);

  return { O, OE };
}

/**
 * Algorithm 10 — Computing Perms (ISO 32000-2:2020)
 *
 * @param {number} permissions - 32-bit permission flags
 * @param {Uint8Array} fileKey - 32-byte file encryption key
 * @param {boolean} encryptMetadata - Whether metadata is encrypted
 * @returns {Promise<Uint8Array>} - 16-byte Perms value
 */
async function computePerms(permissions, fileKey, encryptMetadata) {
  const block = new Uint8Array(16);

  // Bytes 0-3: permissions (little-endian)
  block[0] = permissions & 0xFF;
  block[1] = (permissions >> 8) & 0xFF;
  block[2] = (permissions >> 16) & 0xFF;
  block[3] = (permissions >> 24) & 0xFF;

  // Bytes 4-7: 0xFFFFFFFF (per spec)
  block[4] = 0xFF;
  block[5] = 0xFF;
  block[6] = 0xFF;
  block[7] = 0xFF;

  // Byte 8: 'T' or 'F' for EncryptMetadata
  block[8] = encryptMetadata ? 0x54 : 0x46; // 'T' or 'F'

  // Bytes 9-11: 'a', 'd', 'b' (per spec)
  block[9] = 0x61;  // 'a'
  block[10] = 0x64; // 'd'
  block[11] = 0x62; // 'b'

  // Bytes 12-15: random data
  const rand = randomBytes(4);
  block[12] = rand[0];
  block[13] = rand[1];
  block[14] = rand[2];
  block[15] = rand[3];

  // AES-256-ECB encrypt
  return await aes256EcbEncryptBlock(block, fileKey);
}

/**
 * Encrypt data for a specific object using AES-256-CBC
 * Per PDF 2.0: file encryption key used directly (no per-object derivation)
 * Random 16-byte IV prepended to ciphertext
 */
async function encryptObjectAES256(data, cryptoKey) {
  const iv = randomBytes(16);
  const encrypted = await aes256CbcEncryptWithKey(data, cryptoKey, iv);
  // Prepend IV to ciphertext (PDF spec requirement)
  const result = new Uint8Array(16 + encrypted.length);
  result.set(iv, 0);
  result.set(encrypted, 16);
  return result;
}

// ========== String/Object Encryption ==========

/**
 * Encode raw bytes into the *escaped* form pdf-lib expects for a literal string.
 *
 * pdf-lib writes `PDFString.value` verbatim between `(` and `)` and escapes
 * nothing (see its own comment in core/objects/PDFString.js). That is fine for
 * text, but ciphertext is uniformly random binary, so ~40% of encrypted strings
 * contain a byte that changes the meaning of the literal — silently destroying
 * the object structure of the file. Escape them here.
 *
 * Per ISO 32000-2 §7.3.4.2:
 *   \  → \\   backslash introduces an escape sequence
 *   (  → \(   an unbalanced paren ends the string early or swallows objects
 *   )  → \)
 *   CR → \r   a raw EOL inside a literal string is normalised to LF on read
 *   LF → \n   (not strictly required, but keeps the emitted string on one line)
 */
function bytesToPDFStringValue(bytes) {
  const out = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x5c) out[i] = '\\\\';        // backslash
    else if (b === 0x28) out[i] = '\\(';    // (
    else if (b === 0x29) out[i] = '\\)';    // )
    else if (b === 0x0d) out[i] = '\\r';    // CR
    else if (b === 0x0a) out[i] = '\\n';    // LF
    else out[i] = String.fromCharCode(b);
  }
  return out.join('');
}

/**
 * ISO 32000-2 §7.6.2: the /Contents entry of a signature dictionary holds the
 * signature over the rest of the file and shall NOT be encrypted. /Type is
 * optional on signature dictionaries, so /ByteRange is the reliable marker.
 */
function isSignatureDict(dict) {
  const type = dict.get(PDFName.of('Type'));
  const typeName = type && typeof type.asString === 'function' ? type.asString() : null;
  if (typeName === '/Sig' || typeName === '/DocTimeStamp') return true;

  // /Type is optional on a signature dictionary, so fall back to shape. Only do
  // so when /Type is absent — an explicit non-signature /Type means some other
  // dictionary happens to use these key names, and leaving its /Contents in
  // plaintext would leak it.
  if (typeName !== null) return false;
  const byteRange = dict.get(PDFName.of('ByteRange'));
  return byteRange instanceof PDFArray && byteRange.size() === 4 && dict.has(PDFName.of('Contents'));
}

/** Dictionary keys that must never be encrypted. */
function skipKey(keyName, isSigDict) {
  if (keyName === '/Length' || keyName === '/Filter' || keyName === '/DecodeParms') return true;
  return isSigDict && keyName === '/Contents';
}

/**
 * Recursively encrypt strings in a PDF object (RC4 mode)
 *
 * `seen` is a document-wide WeakSet. Parsed documents are trees here (indirect
 * references are `PDFRef`s, which this does not follow), but a programmatically
 * built document can share or self-reference a *direct* object — which would
 * otherwise recurse forever or encrypt the same string twice.
 */
function encryptStringsRC4(obj, objectNum, generationNum, encryptionKey, seen) {
  if (!obj || seen.has(obj)) return;

  if (obj instanceof PDFString) {
    seen.add(obj);
    const originalBytes = obj.asBytes();
    const encrypted = encryptObjectRC4(originalBytes, objectNum, generationNum, encryptionKey);
    obj.value = bytesToPDFStringValue(encrypted);
  } else if (obj instanceof PDFHexString) {
    seen.add(obj);
    const originalBytes = obj.asBytes();
    const encrypted = encryptObjectRC4(originalBytes, objectNum, generationNum, encryptionKey);
    obj.value = bytesToHex(encrypted);
  } else if (obj instanceof PDFDict) {
    seen.add(obj);
    const isSigDict = isSignatureDict(obj);
    for (const [key, value] of obj.entries()) {
      if (!skipKey(key.asString(), isSigDict)) {
        encryptStringsRC4(value, objectNum, generationNum, encryptionKey, seen);
      }
    }
  } else if (obj instanceof PDFArray) {
    seen.add(obj);
    for (const element of obj.asArray()) {
      encryptStringsRC4(element, objectNum, generationNum, encryptionKey, seen);
    }
  }
}

/**
 * Recursively encrypt strings in a PDF object (AES-256 mode)
 * For AES-256, strings get AES-256-CBC with random IV prepended
 */
async function encryptStringsAES256(obj, objectNum, generationNum, cryptoKey, seen) {
  if (!obj || seen.has(obj)) return;

  if (obj instanceof PDFString) {
    seen.add(obj);
    const originalBytes = obj.asBytes();
    const encrypted = await encryptObjectAES256(originalBytes, cryptoKey);
    obj.value = bytesToPDFStringValue(encrypted);
  } else if (obj instanceof PDFHexString) {
    seen.add(obj);
    const originalBytes = obj.asBytes();
    const encrypted = await encryptObjectAES256(originalBytes, cryptoKey);
    obj.value = bytesToHex(encrypted);
  } else if (obj instanceof PDFDict) {
    seen.add(obj);
    const isSigDict = isSignatureDict(obj);
    for (const [key, value] of obj.entries()) {
      if (!skipKey(key.asString(), isSigDict)) {
        await encryptStringsAES256(value, objectNum, generationNum, cryptoKey, seen);
      }
    }
  } else if (obj instanceof PDFArray) {
    seen.add(obj);
    for (const element of obj.asArray()) {
      await encryptStringsAES256(element, objectNum, generationNum, cryptoKey, seen);
    }
  }
}

// ========== Main Encryption Function ==========

/**
 * Encrypt a PDF with password protection
 *
 * @param {Uint8Array} pdfBytes - The PDF file as bytes
 * @param {string} userPassword - Password required to open the PDF
 * @param {Object} [options] - Encryption options
 * @param {string} [options.ownerPassword] - Owner password (defaults to userPassword)
 * @param {'AES-256'|'RC4'} [options.algorithm='AES-256'] - Encryption algorithm
 * @param {boolean} [options.allowPrinting=true] - Allow printing
 * @param {boolean} [options.allowModifying=true] - Allow modification
 * @param {boolean} [options.allowCopying=true] - Allow copying text
 * @param {boolean} [options.allowAnnotating=true] - Allow annotations
 * @param {boolean} [options.allowFillingForms=true] - Allow form filling
 * @param {boolean} [options.allowExtraction=true] - Allow accessibility extraction
 * @param {boolean} [options.allowAssembly=true] - Allow document assembly
 * @param {boolean} [options.allowHighQualityPrint=true] - Allow high-quality printing
 * @returns {Promise<Uint8Array>} - The encrypted PDF bytes
 *
 * @example
 * // AES-256 (default, recommended)
 * const encrypted = await encryptPDF(pdfBytes, 'secret123');
 *
 * // With owner password and restricted permissions
 * const encrypted = await encryptPDF(pdfBytes, 'user', {
 *   ownerPassword: 'owner',
 *   allowPrinting: true,
 *   allowCopying: false,
 *   allowModifying: false
 * });
 *
 * // RC4 legacy mode
 * const encrypted = await encryptPDF(pdfBytes, 'password', { algorithm: 'RC4' });
 */
export async function encryptPDF(pdfBytes, userPassword, options = {}) {
  const algorithm = options.algorithm || 'AES-256';
  const ownerPassword = options.ownerPassword || userPassword;

  if (algorithm === 'AES-256') {
    return encryptPDF_AES256(pdfBytes, userPassword, ownerPassword, options);
  } else if (algorithm === 'RC4') {
    return encryptPDF_RC4(pdfBytes, userPassword, ownerPassword, options);
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm}. Use 'AES-256' or 'RC4'.`);
  }
}

// ========== AES-256 Encryption (V=5, R=6) ==========

async function encryptPDF_AES256(pdfBytes, userPassword, ownerPassword, options) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });

    if (pdfDoc.isEncrypted) throw new AlreadyEncryptedError();

    const context = pdfDoc.context;
    const permissions = buildPermissions(options);

    // Generate file ID
    let fileId = getOrCreateFileId(context);

    // Generate random 32-byte file encryption key
    const fileKey = randomBytes(32);

    // Prepare password bytes
    const userPwdBytes = encodePasswordAES256(userPassword);
    const ownerPwdBytes = encodePasswordAES256(ownerPassword);

    // Algorithm 8: Compute U and UE
    const { U, UE } = await computeUandUE(userPwdBytes, fileKey);

    // Algorithm 9: Compute O and OE
    const { O, OE } = await computeOandOE(ownerPwdBytes, fileKey, U);

    // Algorithm 10: Compute Perms
    const Perms = await computePerms(permissions, fileKey, true);

    // Import AES key for reuse across all object encryptions
    const cryptoKey = await importAES256Key(fileKey);

    // Encrypt all objects
    const indirectObjects = context.enumerateIndirectObjects();
    const seen = new WeakSet();

    for (const [ref, obj] of indirectObjects) {
      const objectNum = ref.objectNumber;
      const generationNum = ref.generationNumber || 0;

      // Skip encryption dictionary
      if (obj instanceof PDFDict) {
        const filter = obj.get(PDFName.of('Filter'));
        if (filter && filter.asString() === '/Standard') continue;
      }

      // Skip XRef and Sig streams
      if (obj instanceof PDFRawStream && obj.dict) {
        const type = obj.dict.get(PDFName.of('Type'));
        if (type) {
          const typeName = type.toString();
          if (typeName === '/XRef' || typeName === '/Sig') continue;
        }
      }

      // Encrypt streams
      if (obj instanceof PDFRawStream) {
        const streamData = obj.contents;
        const encrypted = await encryptObjectAES256(streamData, cryptoKey);
        obj.contents = encrypted;

        // Encrypt strings in stream dictionary
        if (obj.dict) {
          await encryptStringsAES256(obj.dict, objectNum, generationNum, cryptoKey, seen);
        }
      }

      // Encrypt strings in non-stream objects
      if (!(obj instanceof PDFRawStream)) {
        await encryptStringsAES256(obj, objectNum, generationNum, cryptoKey, seen);
      }
    }

    // Build the encryption dictionary for AES-256
    // StdCF crypt filter
    const stdCF = context.obj({
      Type: PDFName.of('CryptFilter'),
      CFM: PDFName.of('AESV3'),
      Length: PDFNumber.of(32),
      AuthEvent: PDFName.of('DocOpen'),
    });

    const cfDict = context.obj({});
    cfDict.set(PDFName.of('StdCF'), stdCF);

    const encryptDict = context.obj({
      Filter: PDFName.of('Standard'),
      V: PDFNumber.of(5),
      R: PDFNumber.of(6),
      Length: PDFNumber.of(256),
      P: PDFNumber.of(permissions),
      O: PDFHexString.of(bytesToHex(O)),
      U: PDFHexString.of(bytesToHex(U)),
      OE: PDFHexString.of(bytesToHex(OE)),
      UE: PDFHexString.of(bytesToHex(UE)),
      Perms: PDFHexString.of(bytesToHex(Perms)),
      StmF: PDFName.of('StdCF'),
      StrF: PDFName.of('StdCF'),
      CF: cfDict,
    });

    // EncryptMetadata: true (default, we always encrypt metadata)
    encryptDict.set(PDFName.of('EncryptMetadata'), context.obj(true));

    const encryptRef = context.register(encryptDict);

    // Update trailer
    const trailer = context.trailerInfo;
    trailer.Encrypt = encryptRef;

    // Ensure file ID is in trailer
    if (!trailer.ID) {
      const idHex1 = PDFHexString.of(bytesToHex(fileId));
      const idHex2 = PDFHexString.of(bytesToHex(fileId));
      trailer.ID = [idHex1, idHex2];
    }

    // updateFieldAppearances defaults to true and runs *inside* save(), i.e. AFTER
    // the encryption pass above — any appearance stream it regenerated would be
    // written as plaintext into an encrypted file. An encryption pass must not
    // rewrite content, so turn it off.
    const encryptedBytes = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
    return encryptedBytes;

  } catch (error) {
    if (isCallerError(error)) throw error;
    if (error.message && error.message.startsWith('Unsupported')) throw error;
    throw new Error(`Failed to encrypt PDF (AES-256): ${error.message}`);
  }
}

// ========== RC4 Encryption (V=2, R=3) ==========

async function encryptPDF_RC4(pdfBytes, userPassword, ownerPassword, options) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBytes, {
      ignoreEncryption: true,
      updateMetadata: false
    });

    if (pdfDoc.isEncrypted) throw new AlreadyEncryptedError();

    const context = pdfDoc.context;
    const permissions = buildPermissions(options);

    let fileId = getOrCreateFileId(context);

    // Compute O (owner) key
    const ownerKey = computeOwnerKeyRC4(ownerPassword, userPassword);

    // Compute encryption key
    const encryptionKey = computeEncryptionKeyRC4(userPassword, ownerKey, permissions, fileId);

    // Compute U (user) key
    const userKey = computeUserKeyRC4(encryptionKey, fileId);

    // Encrypt all objects
    const indirectObjects = context.enumerateIndirectObjects();
    const seen = new WeakSet();

    for (const [ref, obj] of indirectObjects) {
      const objectNum = ref.objectNumber;
      const generationNum = ref.generationNumber || 0;

      if (obj instanceof PDFDict) {
        const filter = obj.get(PDFName.of('Filter'));
        if (filter && filter.asString() === '/Standard') continue;
      }

      if (obj instanceof PDFRawStream && obj.dict) {
        const type = obj.dict.get(PDFName.of('Type'));
        if (type) {
          const typeName = type.toString();
          if (typeName === '/XRef' || typeName === '/Sig') continue;
        }
      }

      if (obj instanceof PDFRawStream) {
        const streamData = obj.contents;
        const encrypted = encryptObjectRC4(streamData, objectNum, generationNum, encryptionKey);
        obj.contents = encrypted;

        if (obj.dict) {
          encryptStringsRC4(obj.dict, objectNum, generationNum, encryptionKey, seen);
        }
      }

      if (!(obj instanceof PDFRawStream)) {
        encryptStringsRC4(obj, objectNum, generationNum, encryptionKey, seen);
      }
    }

    const encryptDict = context.obj({
      Filter: PDFName.of('Standard'),
      V: PDFNumber.of(2),
      R: PDFNumber.of(3),
      Length: PDFNumber.of(128),
      P: PDFNumber.of(permissions),
      O: PDFHexString.of(bytesToHex(ownerKey)),
      U: PDFHexString.of(bytesToHex(userKey)),
    });

    const encryptRef = context.register(encryptDict);

    const trailer = context.trailerInfo;
    trailer.Encrypt = encryptRef;

    if (!trailer.ID) {
      const idHex1 = PDFHexString.of(bytesToHex(fileId));
      const idHex2 = PDFHexString.of(bytesToHex(fileId));
      trailer.ID = [idHex1, idHex2];
    }

    // updateFieldAppearances defaults to true and runs *inside* save(), i.e. AFTER
    // the encryption pass above — any appearance stream it regenerated would be
    // written as plaintext into an encrypted file. An encryption pass must not
    // rewrite content, so turn it off.
    const encryptedBytes = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
    return encryptedBytes;

  } catch (error) {
    if (isCallerError(error)) throw error;
    throw new Error(`Failed to encrypt PDF (RC4): ${error.message}`);
  }
}

// ========== Helpers ==========

/**
 * Get existing file ID from trailer or generate a new one
 */
function getOrCreateFileId(context) {
  const trailer = context.trailerInfo;
  const idArray = trailer.ID;

  // trailerInfo.ID is a PDFArray on a parsed document, but a plain JS array if
  // this function already replaced it. Handle both, and read the value through
  // asBytes() so a literal `(...)` ID decodes as correctly as a hex `<...>` one.
  const first = idArray instanceof PDFArray ? idArray.get(0)
    : (Array.isArray(idArray) && idArray.length > 0) ? idArray[0]
    : undefined;

  if (first && typeof first.asBytes === 'function') {
    const bytes = first.asBytes();
    if (bytes.length > 0) return bytes;
  }

  // Generate new file ID
  const fileId = randomBytes(16);
  const idHex1 = PDFHexString.of(bytesToHex(fileId));
  const idHex2 = PDFHexString.of(bytesToHex(fileId));
  trailer.ID = [idHex1, idHex2];
  return fileId;
}
