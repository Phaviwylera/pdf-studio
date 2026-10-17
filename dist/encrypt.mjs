import { encryptPDF } from './vendor/pdf-encrypt/index.mjs';
import { applyUploadedMetadata, parseUploadedMetadata } from './metadata.mjs';
import { signatureProtectionForDocument } from './native-export.mjs';

/**
 * Create an encrypted copy without changing the editor's currently open document.
 * With metadataFile ({name, data}), only the supplied JSON's Info/XMP fields are
 * written before encryption; the JSON itself is never attached. Without it, the
 * source PDF's existing native metadata is retained unchanged.
 */
export async function encryptPdfCopy({
  bytes, password, ownerPassword = '', metadataFile = null,
  PDFLib, onProgress = () => {}, encrypt = encryptPDF,
}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Choose a PDF to encrypt.');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use an open password with at least 8 characters.');
  if (ownerPassword && ownerPassword.length < 8) throw new Error('The owner password must have at least 8 characters, or be left blank to use the open password.');
  if (ownerPassword && ownerPassword === password) throw new Error('Choose a different owner password, or leave it blank to use the open password.');
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

  let output = bytes.slice();
  if (upload) {
    onProgress('Applying the metadata JSON to native Info/XMP…');
    try {
      applyUploadedMetadata(source, upload, PDFLib);
      output = await source.save({ useObjectStreams: true, addDefaultPage: false });
    } catch (error) {
      throw new Error(`Could not apply the metadata JSON: ${error?.message || 'the PDF could not be saved.'}`);
    }
  }

  onProgress('Encrypting with AES-256…');
  try {
    return await encrypt(output, password, {
      ownerPassword: ownerPassword || password,
      algorithm: 'AES-256',
      allowPrinting: true,
      allowModifying: true,
      allowCopying: true,
      allowAnnotating: true,
      allowFillingForms: true,
      allowExtraction: true,
      allowAssembly: true,
      allowHighQualityPrint: true,
    });
  } catch (error) {
    if (error?.name === 'AlreadyEncryptedError') throw new Error('This PDF is already encrypted. Unlock it before creating a new encrypted copy.');
    if (/crypto|subtle|secure context/i.test(error?.message || '')) throw new Error('AES-256 encryption needs a secure browser context (HTTPS or localhost).');
    throw new Error(error?.message || 'Could not encrypt this PDF.');
  }
}
