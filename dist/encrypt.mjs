import { encryptPDF } from './vendor/pdf-encrypt/index.mjs';
import { applyUploadedMetadata, parseUploadedMetadata } from './metadata.mjs';
import { signatureProtectionForDocument } from './native-export.mjs';
import { applyFileId, sameFileId, fileIdFromDocument } from './file-id.mjs';
import { ensureCatalogVersion, ensurePdfVersion, AES_256_MIN_VERSION } from './pdf-version.mjs';

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

export async function encryptPdfCopy({
  bytes, password, ownerPassword = '', metadataFile = null, fileId = null,
  PDFLib, onProgress = () => {}, encrypt = encryptPDF,
}) {
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
  // AES-256 (V5 / R5) exists from PDF 1.7 on. Raise a stale catalog /Version now
  // so the saved, encrypted document never claims to be an older version than
  // the encryption it carries.
  ensureCatalogVersion(source, AES_256_MIN_VERSION, PDFLib);

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

  onProgress('Encrypting with AES-256…');
  // The opening password must not also be the owner password: otherwise anyone
  // who can open the file can silently lift its permission flags.
  const owner = ownerPassword || randomOwnerPassword();
  try {
    const encrypted = await encrypt(output, password, {
      ownerPassword: owner,
      algorithm: 'AES-256',
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
    const bytes = encrypted instanceof Uint8Array ? encrypted : new Uint8Array(encrypted);
    // pdf-lib writes a 1.7 header already; this covers bytes produced by any
    // other encryptor, and keeps the header and the AES-256 payload in step.
    return ensurePdfVersion({bytes, version: AES_256_MIN_VERSION});
  } catch (error) {
    if (error?.name === 'AlreadyEncryptedError') throw new Error('This PDF is already encrypted. Unlock it before creating a new encrypted copy.');
    if (/crypto|subtle|secure context/i.test(error?.message || '')) throw new Error('AES-256 encryption needs a secure browser context (HTTPS or localhost).');
    throw new Error(error?.message || 'Could not encrypt this PDF.');
  }
}
