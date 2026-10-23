import { encryptPDF } from './vendor/pdf-encrypt/index.mjs';
import { applyUploadedMetadata, parseUploadedMetadata } from './metadata.mjs';
import { signatureProtectionForDocument } from './native-export.mjs';
import { applyFileId, sameFileId, fileIdFromDocument } from './file-id.mjs';
import { ensureCatalogVersion, ensurePdfVersion, AES_256_MIN_VERSION, RC4_128_MIN_VERSION } from './pdf-version.mjs';
import { alignHeader } from './header-marker.mjs';

/**
 * Create an encrypted copy without changing the editor's currently open document.
 * With metadataFile ({name, data}), only the supplied JSON's Info/XMP fields are
 * written before encryption; the JSON itself is never attached. Without it, the
 * source PDF's existing native metadata is retained unchanged.
 */
/**
 * A random owner password for exports that leave the field blank. The owner
 * never needs it: it only exists so the opening password cannot lift the
 * permission flags.
 */
export function randomOwnerPassword() {
  const bytes = new Uint8Array(24);
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The two encryption schemes this app can write. AES-256 is the default because
 * it is the only one that is still considered safe; RC4 128-bit is offered for
 * the files that still require it, typically an older bank or archive system
 * that cannot open anything else. RC4 needs no Web Crypto, so it works in a
 * plain http:// page too.
 */
export const ENCRYPTION_ALGORITHMS = ['AES-256', 'RC4-128'];
export function encryptionLabel(algorithm) {
 return algorithm === 'RC4-128' ? 'RC4 128-bit' : 'AES-256';
}
function normalizeAlgorithm(algorithm) {
 if (algorithm === 'RC4' || algorithm === 'RC4-128' || algorithm === 'RC4 128-bit') return 'RC4-128';
 if (algorithm === undefined || algorithm === null || algorithm === '' || algorithm === 'AES-256') return 'AES-256';
 throw new Error('Unknown encryption algorithm. Choose AES-256 or RC4 128-bit.');
}

export async function encryptPdfCopy({
  bytes, password, ownerPassword = '', metadataFile = null, fileId = null, algorithm = 'AES-256',
  PDFLib, onProgress = () => {}, encrypt = encryptPDF,
}) {
 const scheme = normalizeAlgorithm(algorithm);
 const legacyRc4 = scheme === 'RC4-128';
 const label = encryptionLabel(scheme);
 const minVersion = legacyRc4 ? RC4_128_MIN_VERSION : AES_256_MIN_VERSION;
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Choose a PDF to encrypt.');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use an open password with at least 8 characters.');
  if (ownerPassword && ownerPassword.length < 8) throw new Error('The owner password must have at least 8 characters, or be left blank to use the open password.');
  if (ownerPassword && ownerPassword === password) throw new Error('Choose a different owner password, or leave it blank to protect permissions with a generated one.');
  if (!PDFLib?.PDFDocument) throw new Error('The PDF tools did not load. Reload the page and try again.');

  // Validate the optional UTF-8 JSON replacement before doing any PDF work.
  let upload = null;
  if (metadataFile) {
    onProgress('Validating the metadata JSON…');
    upload = parseUploadedMetadata(metadataFile.data, metadataFile.name);
  }

  onProgress('Checking the PDF and its signatures…');
  let source;
  try {
    source = await PDFLib.PDFDocument.load(bytes.slice(), { updateMetadata: false });
  } catch (error) {
    if ((PDFLib.EncryptedPDFError && error instanceof PDFLib.EncryptedPDFError) || /encrypt/i.test(error?.message || '')) {
      throw new Error('This PDF is already encrypted or password protected. Unlock it first; this tool does not remove or replace existing encryption.');
    }
    throw new Error('This PDF could not be safely inspected. Check that it is a valid, unencrypted PDF.');
  }
  if (signatureProtectionForDocument(source, PDFLib).locked) {
    throw new Error('This PDF contains a digital signature. Encrypting a rewritten copy would invalidate it, so signed PDFs are not modified.');
  }
  // AES-256 (V5 / R5) exists from PDF 1.7 on; RC4 128-bit from 1.4. Raise a stale
  // catalog /Version now so the saved, encrypted document never claims to be an
  // older version than the encryption it carries. Nothing is ever lowered.
  ensureCatalogVersion(source, minVersion, PDFLib);

  let output = bytes.slice();
  let restoreFileId = !!fileId && !sameFileId(fileId, fileIdFromDocument(source, PDFLib));
  if (upload) {
    onProgress('Applying the metadata JSON to native Info/XMP…');
    try {
      applyUploadedMetadata(source, upload, PDFLib);
      if (restoreFileId) applyFileId(source, fileId, PDFLib);
      output = await source.save({ useObjectStreams: true, addDefaultPage: false });
      restoreFileId = false;
    } catch (error) {
      throw new Error(`Could not apply the metadata JSON: ${error?.message || 'the PDF could not be saved.'}`);
    }
  }
  // Keep the source trailer /ID (both values, and its literal or hexadecimal
  // encoding) across the encryption rewrite. The encrypted trailer is written
  // from the input document, so restoring it here is enough.
  if (restoreFileId) {
    onProgress('Restoring the source file identifier…');
    try {
      applyFileId(source, fileId, PDFLib);
      output = await source.save({ useObjectStreams: true, addDefaultPage: false });
    } catch (error) {
      throw new Error(`Could not restore the source file identifier: ${error?.message || 'the PDF could not be saved.'}`);
    }
  }

  onProgress(`Encrypting with ${label}…`);
  // The opening password must not also be the owner password: otherwise anyone
  // who can open the file can silently lift its permission flags.
  const owner = ownerPassword || randomOwnerPassword();
  try {
    const encrypted = await encrypt(output, password, {
      ownerPassword: owner,
      algorithm: legacyRc4 ? 'RC4' : 'AES-256',
      // The exported copy is final. Permissions keep it printable, copyable and
      // accessible while forbidding the silent edits that mark a rewrite.
      allowPrinting: true,
      allowHighQualityPrint: true,
      allowModifying: false,
      allowAssembly: false,
      allowCopying: true,
      allowAnnotating: false,
      allowFillingForms: false,
      allowExtraction: true,
    });
    const raw = encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
    // The header must not claim an older version than the encryption it carries;
    // this covers bytes produced by any other encryptor and raises only.
    const raised = ensurePdfVersion({bytes: raw, version: minVersion});
    // Encryption is a second save, and the encryptor writes its own binary marker
    // after the version line. Re-align to the copy that came in, so an encrypted
    // export names the same writer as the plain one instead of naming this library.
    return alignHeader(raised, bytes);
  } catch (error) {
    if (error?.name === 'AlreadyEncryptedError') throw new Error('This PDF is already encrypted. Unlock it before creating a new encrypted copy.');
    if (!legacyRc4 && /crypto|subtle|secure context/i.test(error?.message || '')) throw new Error('AES-256 encryption needs a secure browser context (HTTPS or localhost). RC4 128-bit works without it.');
    throw new Error(error?.message || 'Could not encrypt this PDF.');
  }
}
