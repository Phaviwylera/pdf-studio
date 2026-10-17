import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
globalThis.PDFLib = L; // Browser bundle exposes the same UMD global before app modules load.
const {encryptPdfCopy} = await import('../dist/encrypt.mjs');
const decode = bytes => new TextDecoder().decode(bytes);

async function samplePdf({signed = false} = {}) {
 const pdf = await L.PDFDocument.create();
 pdf.addPage([300, 200]).drawText('Private document', {x: 24, y: 140});
 pdf.setTitle('Native title');
 pdf.setAuthor('Native author');
 if (signed) {
  const signature = pdf.context.register(pdf.context.obj({Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: L.PDFHexString.of('0000')}));
  pdf.catalog.set(L.PDFName.of('TestSignature'), signature);
 }
 return pdf.save();
}

function pdfjsFor({info = {Title: 'Native title', Author: 'Native author'}, pages = 1} = {}) {
 return {
  getDocument() {
   return {promise: Promise.resolve({numPages: pages, getMetadata: async () => ({info, metadata: null}), destroy: async () => {}})};
  },
 };
}

 test('AES-256 creates a password-protected PDF and embeds the native metadata report before encryption', async () => {
 const source = await samplePdf();
 const originalAttach = L.PDFDocument.prototype.attach;
 let attached = null;
 L.PDFDocument.prototype.attach = async function(data, name, options) {
  attached = {data: new Uint8Array(data), name, options};
  return originalAttach.call(this, data, name, options);
 };
 try {
  const encrypted = await encryptPdfCopy({
   bytes: source, filename: 'report.pdf', password: 'open-password-123', ownerPassword: 'owner-password-456',
   embedMetadata: true, PDFLib: L, pdfjs: pdfjsFor({pages: 3}),
  });
  const raw = decode(encrypted);
  assert.match(raw, /\/Encrypt/);
  assert.match(raw, /\/AESV3/);
  assert.ok(attached, 'metadata JSON is embedded before encryption');
  assert.equal(attached.name, 'pdf-studio-source-metadata.json');
  assert.equal(attached.options.mimeType, 'application/json');
  const record = JSON.parse(decode(attached.data));
  assert.equal(record.schema, 'pdf-studio/source-metadata/v1');
  assert.equal(record.source.filename, 'report.pdf');
  assert.equal(record.source.pages, 3);
  assert.equal(record.info.Title, 'Native title');
  assert.equal(record.info.Author, 'Native author');
  await assert.rejects(L.PDFDocument.load(encrypted), /encrypted/);
 } finally {
  L.PDFDocument.prototype.attach = originalAttach;
 }
});

test('metadata attachment is optional and password-confirmation rules are enforced by the encryptor', async () => {
 const source = await samplePdf();
 let metadataRead = false;
 const encrypted = await encryptPdfCopy({
  bytes: source, filename: 'private.pdf', password: 'open-password-123', embedMetadata: false,
  PDFLib: L, pdfjs: {getDocument() { metadataRead = true; throw new Error('must not inspect metadata'); }},
 });
 assert.equal(metadataRead, false);
 assert.match(decode(encrypted), /\/Encrypt/);
 await assert.rejects(encryptPdfCopy({bytes: source, password: 'short', PDFLib: L, pdfjs: pdfjsFor()}), /at least 8 characters/);
 await assert.rejects(encryptPdfCopy({bytes: source, password: 'open-password-123', ownerPassword: 'open-password-123', PDFLib: L, pdfjs: pdfjsFor()}), /different owner password/);
});

test('existing encrypted and digitally signed PDFs are not rewritten', async () => {
 const source = await samplePdf();
 const encrypted = await encryptPdfCopy({bytes: source, password: 'open-password-123', embedMetadata: false, PDFLib: L, pdfjs: pdfjsFor()});
 await assert.rejects(encryptPdfCopy({bytes: encrypted, password: 'second-password-123', PDFLib: L, pdfjs: pdfjsFor()}), /already encrypted|password protected/i);
 const signed = await samplePdf({signed: true});
 await assert.rejects(encryptPdfCopy({bytes: signed, password: 'open-password-123', PDFLib: L, pdfjs: pdfjsFor()}), /digital signature/);
});
