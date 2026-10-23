import { encryptPdfCopy as encryptPdfCopyDefault } from './encrypt.mjs';
import { enforceFileId } from './file-id.mjs';

export const MIN_EXPORT_PASSWORD_LENGTH = 8;

/**
 * Validate the editor's export password fields before any PDF work starts.
 * Passwords are returned unchanged (never trimmed), used for one export and then
 * discarded by the caller. Nothing here stores, logs or transmits them.
 */
export function validateExportPasswords({password = '', confirmation = '', ownerPassword = ''} = {}) {
 if (typeof password !== 'string' || password.length < MIN_EXPORT_PASSWORD_LENGTH) {
  throw new Error('Use an open password with at least 8 characters.');
 }
 if (typeof confirmation !== 'string' || confirmation !== password) {
  throw new Error('The open password and its confirmation do not match.');
 }
 if (ownerPassword && (typeof ownerPassword !== 'string' || ownerPassword.length < MIN_EXPORT_PASSWORD_LENGTH)) {
  throw new Error('The owner password must have at least 8 characters, or be left blank to use the open password.');
 }
 if (ownerPassword && ownerPassword === password) {
  throw new Error('Choose a different owner password, or leave it blank to use the open password.');
 }
 return {password, ownerPassword};
}

/** Name an encrypted editor export so the download is unambiguous. */
export function encryptedExportName(name = 'document.pdf') {
 const base = String(name || 'document.pdf').replace(/\.pdf$/i, '');
 return `${base || 'document'}-encrypted.pdf`;
}

/**
 * Encrypt the bytes already produced by exportNativePdf. The native export is
 * created first, so edits and any selected metadata replacement are inside these
 * bytes; encryptPdfCopy then protects that exact document with AES-256.
 */
export async function encryptExportCopy({
 bytes, password, confirmation, ownerPassword = '', fileId = null,
 PDFLib, encryptPdfCopy = encryptPdfCopyDefault, onProgress = () => {},
}) {
 if (!(bytes instanceof Uint8Array) || !bytes.length) {
  throw new Error('Create the native export before encrypting it.');
 }
 const checked = validateExportPasswords({password, confirmation, ownerPassword});
 // The native export already carries the selected /ID; make sure the bytes
 // handed to the encryptor do too, because its rewrite preserves the trailer
 // identifier of its input.
 const prepared = (await enforceFileId({bytes, fileId, PDFLib, encrypted: false})).bytes;
 onProgress('Encrypting the exported PDF with AES-256…');
 return encryptPdfCopy({
  bytes: prepared, password: checked.password, ownerPassword: checked.ownerPassword, PDFLib, onProgress,
 });
}
