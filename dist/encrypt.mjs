import { encryptPDF } from './vendor/pdf-encrypt/index.mjs';
import { makeSourceMetadataRecord, attachSourceMetadata, capturePdfMetadata, restorePdfMetadata } from './metadata.mjs';
import { signatureProtectionForDocument } from './native-export.mjs';

export const ENCRYPTED_METADATA_ATTACHMENT = 'pdf-studio-source-metadata.json';

/**
 * Create an encrypted copy without changing the editor's currently open document.
 * When requested, a JSON report of the PDF's native Info/XMP metadata is attached
 * before encryption, so the attachment itself is protected along with the PDF.
 */
export async function encryptPdfCopy({
  bytes, filename, password, ownerPassword = '', embedMetadata = true,
  PDFLib, pdfjs, onProgress = () => {},
}) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Choose a PDF to encrypt.');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Use an open password with at least 8 characters.');
  if (ownerPassword && ownerPassword.length < 8) throw new Error('The owner password must have at least 8 characters, or be left blank to use the open password.');
  if (ownerPassword && ownerPassword === password) throw new Error('Choose a different owner password, or leave it blank to use the open password.');
  if (!PDFLib?.PDFDocument || !pdfjs?.getDocument) throw new Error('The PDF tools did not load. Reload the page and try again.');

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
  if (embedMetadata) {
    onProgress('Reading the PDF’s native metadata…');
    const saved = capturePdfMetadata(source, PDFLib);
    let jsDocument;
    try {
      jsDocument = await pdfjs.getDocument({ data: bytes.slice(), cMapUrl: './vendor/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/standard_fonts/', wasmUrl: './vendor/wasm/', fontExtraProperties: true }).promise;
      const metadata = await jsDocument.getMetadata();
      const record = makeSourceMetadataRecord({
        filename: filename || 'document.pdf',
        byteLength: bytes.length,
        pageCount: jsDocument.numPages,
        inspection: { unknown: false },
        metadata,
      });
      onProgress('Embedding the native metadata report…');
      await attachSourceMetadata(source, record, PDFLib);
      restorePdfMetadata(source, PDFLib, saved);
      output = await source.save({ useObjectStreams: true, addDefaultPage: false });
    } catch (error) {
      if (error?.message?.includes('metadata')) throw error;
      throw new Error('Could not read and embed this PDF’s native metadata. Turn off the metadata option to encrypt without the JSON attachment.');
    } finally {
      if (jsDocument) await jsDocument.destroy();
    }
  }

  onProgress('Encrypting with AES-256…');
  try {
    return await encryptPDF(output, password, {
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
