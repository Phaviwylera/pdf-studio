// PDF version bookkeeping.
//
// Two things state a PDF's version: the `%PDF-x.y` header and, optionally, a
// `/Version` entry in the catalog. A file whose header says 1.7 but whose
// catalog still says 1.4 reads as a 1.4 document that was rewritten by a newer
// tool, and AES-256 encryption (V5 / R5) is only defined from PDF 1.7 on. An
// exporter that writes AES-256 into a document claiming 1.4 is therefore a
// fingerprint, so both places are raised together.

export const AES_256_MIN_VERSION = '1.7';
// RC4 with a 128-bit key (V 2 / R 3) is defined from PDF 1.4 on. A file that
// already claims a newer version keeps it: nothing about RC4 needs raising.
export const RC4_128_MIN_VERSION = '1.4';

function versionNumber(version) {
 const match = /^(\d+)\.(\d+)$/.exec(String(version || '').trim());
 return match ? Number(match[1]) * 100 + Number(match[2]) : null;
}

export function compareVersions(a, b) {
 const left = versionNumber(a), right = versionNumber(b);
 if (left === null || right === null) return null;
 return left - right;
}

/** The version written in the `%PDF-x.y` header, or null when it is unreadable. */
export function pdfHeaderVersion(bytes) {
 if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null;
 // The header must start the file, but readers tolerate a small junk prefix.
 const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
 const match = /%PDF-(\d+\.\d+)/.exec(head);
 return match ? match[1] : null;
}

/**
 * Rewrite the header version in a copy of the bytes. The header has a fixed
 * length per version string, so this never shifts any offset.
 */
export function withHeaderVersion(bytes, version = AES_256_MIN_VERSION) {
 if (!(bytes instanceof Uint8Array)) return bytes;
 const current = pdfHeaderVersion(bytes);
 if (!current) return bytes;
 if (compareVersions(current, version) >= 0) return bytes;
 const out = bytes.slice();
 const encoded = new TextEncoder().encode(`%PDF-${version}`);
 const offset = out.indexOf(0x25); // '%'
 if (offset < 0 || offset + encoded.length > out.length) return bytes;
 out.set(encoded, offset);
 return out;
}

/**
 * Raise a catalog `/Version` that is lower than required. The catalog entry is
 * optional, so a document without one is left alone: the header already
 * describes it. Returns true when the catalog changed.
 */
export function ensureCatalogVersion(document, version, L) {
 const catalog = document?.catalog;
 if (!catalog) return false;
 const key = L.PDFName.of('Version');
 const current = catalog.get(key);
 if (!current) return false;
 const value = current.toString().replace(/^\//, '');
 if (compareVersions(value, version) === null || compareVersions(value, version) >= 0) return false;
 catalog.set(key, L.PDFName.of(version));
 return true;
}

/**
 * Raise a catalog `/Version` written as a name in the raw bytes. Same-length
 * replacements only, so cross-reference offsets stay valid. This covers files
 * produced by another encryptor whose catalog we never held as an object.
 */
export function withCatalogVersion(bytes, version = AES_256_MIN_VERSION) {
 if (!(bytes instanceof Uint8Array)) return bytes;
 const target = versionNumber(version);
 if (target === null) return bytes;
 const text = new TextDecoder('latin1').decode(bytes);
 const pattern = /\/Version\s*\/1\.(\d)/g;
 let out = null, match;
 while ((match = pattern.exec(text))) {
  const current = 100 + Number(match[1]);
  if (current >= target) continue;
  const replacement = match[0].replace(/1\.\d$/, version);
  if (!out) out = bytes.slice();
  const start = match.index;
  const encoded = new TextEncoder().encode(replacement);
  if (encoded.length !== match[0].length) continue; // never shift an offset
  out.set(encoded, start);
 }
 return out || bytes;
}

/** Header and catalog both at least `version`. */
export function ensurePdfVersion({bytes, document = null, version = AES_256_MIN_VERSION, L = null} = {}) {
 if (document && L) ensureCatalogVersion(document, version, L);
 if (!bytes) return bytes;
 return withCatalogVersion(withHeaderVersion(bytes, version), version);
}
