// PDF trailer /ID preservation.
//
// A PDF trailer may hold an array of two byte strings: the permanent identifier
// created with the file and the changing identifier written when the file is
// saved. A rewrite (qpdf decryption, another editor, a print-to-PDF step) often
// replaces or re-encodes those values, which makes downstream checks report that
// the file identity changed. Capture the uploaded file's exact pair and write it
// back into every export we produce.

import {alignHeader} from './header-marker.mjs';

const MAX_SCAN_BYTES = 262144;

export function hexFromBytes(bytes) {
 let hex = '';
 for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
 return hex.toUpperCase();
}

function hexToBytes(hex) {
 const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
 const padded = clean.length % 2 ? clean + '0' : clean;
 const bytes = new Uint8Array(padded.length / 2);
 for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
 return bytes;
}

function latin1(bytes) {
 let text = '';
 for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
 return text;
}

function decodeLiteral(raw) {
 const out = [];
 for (let i = 0; i < raw.length; i++) {
  const char = raw[i];
  if (char !== '\\') {
   out.push(raw.charCodeAt(i));
   continue;
  }
  const next = raw[++i];
  if (next === undefined) break;
  if (next === '\r') {
   if (raw[i + 1] === '\n') i++;
   continue;
  }
  if (next === '\n') continue;
  const escapes = {n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92};
  if (Object.hasOwn(escapes, next)) {
   out.push(escapes[next]);
   continue;
  }
  if (/[0-7]/.test(next)) {
   let octal = next;
   for (let count = 0; count < 2 && /[0-7]/.test(raw[i + 1] || ''); count++) octal += raw[++i];
   out.push(parseInt(octal, 8) & 255);
   continue;
  }
  out.push(next.charCodeAt(0));
 }
 return Uint8Array.from(out);
}

// Read `/ID [ ... ]` from raw PDF bytes without a full parse. Used as a fallback
// when the document library cannot load a file, e.g. a damaged or unsupported
// encrypted trailer. The main trailer is normally the last /ID in the file.
export function scanPdfFileId(bytes) {
 if (!(bytes instanceof Uint8Array) || !bytes.length) return null;
 const source = latin1(bytes.subarray(Math.max(0, bytes.length - MAX_SCAN_BYTES)));
 let found = null;
 let at = source.indexOf('/ID');
 while (at >= 0) {
  const record = readIdArray(source, at + 3);
  if (record) found = record;
  at = source.indexOf('/ID', at + 3);
 }
 return found;
}

function readIdArray(source, start) {
 let i = start;
 const skip = () => {
  while (i < source.length && /\s/.test(source[i])) i++;
 };
 skip();
 if (source[i] !== '[') return null;
 i++;
 const entries = [];
 for (let count = 0; count < 2; count++) {
  skip();
  if (source[i] === '<' && source[i + 1] !== '<') {
   const end = source.indexOf('>', i + 1);
   if (end < 0) return null;
   const hex = source.slice(i + 1, end).replace(/\s+/g, '');
   if (!/^[0-9a-f]*$/i.test(hex)) return null;
   entries.push({hex: hexFromBytes(hexToBytes(hex)), type: 'hex'});
   i = end + 1;
  } else if (source[i] === '(') {
   let depth = 1, j = i + 1;
   while (j < source.length && depth) {
    if (source[j] === '\\') j += 2;
    else if (source[j] === '(') { depth++; j++; }
    else if (source[j] === ')') { depth--; j++; }
    else j++;
   }
   if (depth) return null;
   entries.push({hex: hexFromBytes(decodeLiteral(source.slice(i + 1, j - 1))), type: 'literal'});
   i = j;
  } else return null;
 }
 skip();
 if (source[i] !== ']') return null;
 return makeRecord(entries);
}

function makeRecord(entries) {
 if (!entries.length) return null;
 const permanent = entries[0];
 const changing = entries[1] || entries[0];
 if (!permanent.hex && !changing.hex) return null;
 return {
  permanent: permanent.hex,
  changing: changing.hex,
  permanentType: permanent.type,
  changingType: changing.type,
  count: entries.length,
 };
}

/** Read the trailer /ID pair from a loaded pdf-lib document, or null when absent. */
export function fileIdFromDocument(document, L) {
 const context = document?.context;
 if (!context) return null;
 let value = context.trailerInfo?.ID;
 if (L.PDFRef && value instanceof L.PDFRef) value = context.lookup(value);
 if (!value) return null;
 const size = typeof value.size === 'function' ? value.size() : Array.isArray(value) ? value.length : 0;
 if (!size) return null;
 const entries = [];
 for (let index = 0; index < size; index++) {
  let entry = typeof value.get === 'function' ? value.get(index) : value[index];
  if (L.PDFRef && entry instanceof L.PDFRef) entry = context.lookup(entry);
  if (!entry || typeof entry.asBytes !== 'function') return null;
  const hex = hexFromBytes(entry.asBytes());
  if (!hex) return null;
  const isHex = L.PDFHexString ? entry instanceof L.PDFHexString : entry.constructor?.name === 'PDFHexString';
  entries.push({hex, type: isHex ? 'hex' : 'literal'});
 }
 return makeRecord(entries);
}

/** Read the trailer /ID pair from PDF bytes. Encrypted files are read via the
 *  fallback scanner because their document objects stay encrypted. */
export async function readPdfFileId(bytes, L) {
 if (!(bytes instanceof Uint8Array) || !bytes.length) return null;
 // The trailer is never encrypted, so the raw scan reads encrypted files too and
 // avoids parsing the whole document just to look at two byte strings.
 try {
  const record = scanPdfFileId(bytes);
  if (record) return record;
 } catch {}
 if (L?.PDFDocument) {
  try {
   const document = await L.PDFDocument.load(bytes.slice(), {ignoreEncryption: true, updateMetadata: false});
   return fileIdFromDocument(document, L);
  } catch {}
 }
 return null;
}

export function fileIdKey(id) {
 if (!id || (!id.permanent && !id.changing)) return '';
 return `${id.permanent || ''}:${id.changing || id.permanent || ''}`;
}

export function sameFileId(a, b) {
 if (!a && !b) return true;
 if (!a || !b) return false;
 return fileIdKey(a) === fileIdKey(b);
}

function pdfStringFor(record, part, L) {
 const hex = record[part] || record[part === 'permanent' ? 'changing' : 'permanent'] || '';
 const type = record[`${part}Type`];
 if (type === 'literal' && L.PDFString) return L.PDFString.of(latin1(hexToBytes(hex)));
 return L.PDFHexString.of(hex);
}

/**
 * Write a captured /ID pair into a pdf-lib document before saving. Passing null
 * leaves the document's own identifiers untouched.
 */
export function applyFileId(document, id, L) {
 if (!document || !id) return false;
 const context = document.context;
 const entries = [pdfStringFor(id, 'permanent', L)];
 if ((id.count || 2) > 1) entries.push(pdfStringFor(id, 'changing', L));
 context.trailerInfo.ID = context.obj(entries);
 return true;
}

/** State of an exported file against the identifier that should have been kept. */
export function fileIdStatus(expected, actual) {
 if (!expected) return actual ? 'source-missing' : 'none';
 if (!actual) return 'missing';
 return sameFileId(expected, actual) ? 'preserved' : 'changed';
}

export function fileIdWarning(expected, actual) {
 const status = fileIdStatus(expected, actual);
 if (status === 'preserved') return '';
 if (status === 'none') return '';
 if (status === 'source-missing') return 'The source PDF has no /ID. The export has one, so keep the source identifier in mind when comparing files.';
 if (status === 'missing') return 'The exported PDF has no /ID, so the original identifier could not be written back.';
 return 'The exported PDF /ID does not match the identifier selected for export.';
}

/**
 * Make the exported bytes carry the requested /ID. The native export normally
 * writes it before saving; this verifies the final bytes and repairs an
 * unencrypted export if a later step (encryption is checked separately) ignored
 * the trailer value.
 */
export async function enforceFileId({bytes, fileId, PDFLib, encrypted = false}) {
 if (!fileId) return {bytes, status: 'none', repaired: false};
 const actual = await readPdfFileId(bytes, PDFLib);
 if (sameFileId(fileId, actual)) return {bytes, status: 'preserved', repaired: false};
 if (encrypted) return {bytes, status: fileIdStatus(fileId, actual), repaired: false, actual};
 try {
  const document = await PDFLib.PDFDocument.load(bytes.slice(), {updateMetadata: false});
  applyFileId(document, fileId, PDFLib);
  const saved = alignHeader(await document.save({useObjectStreams: true, addDefaultPage: false}), bytes);
  const verified = await readPdfFileId(saved, PDFLib);
  return {bytes: saved, status: fileIdStatus(fileId, verified), repaired: true, actual: verified};
 } catch {
  return {bytes, status: fileIdStatus(fileId, actual), repaired: false, actual};
 }
}
