import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
globalThis.PDFLib = L; // Browser bundle exposes the same UMD global before app modules load.
const {encryptPDF} = await import('../dist/vendor/pdf-encrypt/index.mjs');
const {encryptPdfCopy} = await import('../dist/encrypt.mjs');
const key = name => L.PDFName.of(name);
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);

async function samplePdf({signed = false} = {}) {
 const pdf = await L.PDFDocument.create();
 pdf.addPage([300, 200]).drawText('Private document', {x: 24, y: 140});
 pdf.setTitle('Native title');
 pdf.setAuthor('Native author');
 pdf.setProducer('Native producer');
 pdf.setCreationDate(new Date('2020-01-02T03:04:05Z'));
 pdf.context.lookup(pdf.context.trailerInfo.Info, L.PDFDict).set(key('OriginalCustom'), L.PDFHexString.fromText('original value'));
 const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/">Native XMP</x:xmpmeta>';
 pdf.catalog.set(key('Metadata'), pdf.context.register(pdf.context.flateStream(encode(xml), {Type: 'Metadata', Subtype: 'XML'})));
 if (signed) {
  const signature = pdf.context.register(pdf.context.obj({Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: L.PDFHexString.of('0000')}));
  pdf.catalog.set(key('TestSignature'), signature);
 }
 return pdf.save();
}

function infoEntries(pdf) {
 const info = pdf.context.trailerInfo.Info && pdf.context.lookup(pdf.context.trailerInfo.Info, L.PDFDict);
 return info ? Object.fromEntries([...info.entries()].map(([name, value]) => [name.toString(), value.toString()])) : {};
}

function xmpXml(pdf) {
 const ref = pdf.catalog.get(key('Metadata'));
 return ref ? decode(L.decodePDFRawStream(pdf.context.lookup(ref)).decode()) : null;
}

const metadataFile = (value, name = 'pdf-studio-source-metadata.json') => ({
 name,
 data: encode(typeof value === 'string' ? value : JSON.stringify(value)),
});

function captureEncrypt(onPrepared) {
 return async (bytes, password, options) => {
  onPrepared(bytes);
  return encryptPDF(bytes, password, options);
 };
}

test('AES-256 encryption applies downloaded report Info/XMP and never attaches the JSON', async () => {
 const source = await samplePdf();
 const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/">Replacement XMP</x:xmpmeta>';
 const report = {
  schema: 'pdf-studio/source-metadata/v1', note: 'Source record', available: true,
  source: {filename: 'source.pdf', bytes: source.length, pages: 1},
  info: {PDFFormatVersion: '1.7', IsLinearized: false, Title: 'Report title', Custom: {Project: 'A'}},
  xmp: {fields: {'dc:title': 'Report title'}, raw: xml},
 };
 const originalAttach = L.PDFDocument.prototype.attach;
 let attached = false, prepared = null;
 L.PDFDocument.prototype.attach = async function(...args) {
  attached = true;
  return originalAttach.apply(this, args);
 };
 try {
  const encrypted = await encryptPdfCopy({
   bytes: source, password: 'open-password-123', ownerPassword: 'owner-password-456',
   metadataFile: metadataFile(report), PDFLib: L,
   encrypt: captureEncrypt(bytes => { prepared = bytes; }),
  });
  assert.equal(attached, false, 'the metadata JSON is not attached');
  assert.ok(prepared, 'metadata replacement bytes reach the encryptor');
  const pdf = await L.PDFDocument.load(prepared, {updateMetadata: false});
  assert.deepEqual(Object.keys(infoEntries(pdf)).sort(), ['/Project', '/Title']);
  assert.equal(pdf.getTitle(), 'Report title');
  assert.equal(pdf.getAuthor(), undefined);
  assert.equal(pdf.getProducer(), undefined);
  assert.equal(xmpXml(pdf), xml);
  assert.equal(pdf.catalog.get(key('Names')), undefined);
  assert.equal(decode(prepared).includes('pdf-studio-source-metadata.json'), false);
  assert.match(decode(encrypted), /\/Encrypt/);
  assert.match(decode(encrypted), /\/AESV3/);
  await assert.rejects(L.PDFDocument.load(encrypted), /encrypted/);
 } finally {
  L.PDFDocument.prototype.attach = originalAttach;
 }
});

test('info/xmp.raw metadata replaces native Info and XMP for encryption', async () => {
 const source = await samplePdf();
 const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/">Info raw XMP</x:xmpmeta>';
 let prepared = null;
 await encryptPdfCopy({
  bytes: source, password: 'open-password-123', PDFLib: L,
  metadataFile: metadataFile({info: {Title: 'Info title', Custom: {Project: '42'}}, xmp: {raw: xml}}),
  encrypt: captureEncrypt(bytes => { prepared = bytes; }),
 });
 const pdf = await L.PDFDocument.load(prepared, {updateMetadata: false});
 assert.deepEqual(Object.keys(infoEntries(pdf)).sort(), ['/Project', '/Title']);
 assert.equal(pdf.getTitle(), 'Info title');
 assert.equal(pdf.getAuthor(), undefined);
 assert.equal(xmpXml(pdf), xml);
});

test('flat metadata JSON replaces Info and removes omitted XMP', async () => {
 const source = await samplePdf();
 let prepared = null;
 await encryptPdfCopy({
  bytes: source, password: 'open-password-123', PDFLib: L,
  metadataFile: metadataFile({Subject: 'Flat subject', Custom: {Project: 7, Ready: true}, Trapped: 'False'}),
  encrypt: captureEncrypt(bytes => { prepared = bytes; }),
 });
 const pdf = await L.PDFDocument.load(prepared, {updateMetadata: false});
 assert.deepEqual(Object.keys(infoEntries(pdf)).sort(), ['/Project', '/Ready', '/Subject', '/Trapped']);
 assert.equal(pdf.getSubject(), 'Flat subject');
 assert.equal(pdf.getTitle(), undefined);
 assert.equal(pdf.getAuthor(), undefined);
 assert.equal(pdf.getProducer(), undefined);
 assert.equal(xmpXml(pdf), null);
 assert.equal(infoEntries(pdf)['/Project'], '7');
});

test('without a metadata JSON the source bytes retain all native Info/XMP for encryption', async () => {
 const source = await samplePdf();
 let prepared = null;
 const encrypted = await encryptPdfCopy({
  bytes: source, password: 'open-password-123', PDFLib: L,
  encrypt: captureEncrypt(bytes => { prepared = bytes; }),
 });
 assert.deepEqual(prepared, source);
 const pdf = await L.PDFDocument.load(prepared, {updateMetadata: false});
 assert.equal(pdf.getTitle(), 'Native title');
 assert.equal(pdf.getAuthor(), 'Native author');
 assert.equal(pdf.getProducer(), 'Native producer');
 assert.equal(infoEntries(pdf)['/OriginalCustom'], L.PDFHexString.fromText('original value').toString());
 assert.match(xmpXml(pdf), /Native XMP/);
 assert.match(decode(encrypted), /\/Encrypt/);
});

test('invalid metadata JSON is rejected before encryption', async () => {
 const source = await samplePdf();
 let encryptCalls = 0;
 const encrypt = async () => { encryptCalls++; return new Uint8Array(); };
 const attempt = (file) => encryptPdfCopy({bytes: source, password: 'open-password-123', PDFLib: L, metadataFile: file, encrypt});
 await assert.rejects(attempt({name: 'metadata.txt', data: encode('{"Title":"No"}')}), /\.json/);
 await assert.rejects(attempt({name: 'metadata.json', data: Uint8Array.of(0xff)}), /UTF-8 JSON object/);
 await assert.rejects(attempt({name: 'metadata.json', data: new Uint8Array(8 * 1024 * 1024 + 1)}), /8 MB/);
 await assert.rejects(attempt(metadataFile('[]')), /UTF-8 JSON object/);
 await assert.rejects(attempt(metadataFile('{bad}')), /UTF-8 JSON object/);
 await assert.rejects(attempt(metadataFile({info: {}, extra: 'ignored'})), /Unsupported metadata field/);
 await assert.rejects(attempt(metadataFile({PDFFormatVersion: '1.7'})), /structure property/);
 await assert.rejects(attempt(metadataFile({xmp: {fields: {'dc:title': 'No raw XML'}}})), /raw XML/);
 await assert.rejects(attempt(metadataFile({xmp: 'not XML'})), /must be XML/);
 assert.equal(encryptCalls, 0);
});

test('password and owner-password rules are enforced by the encryptor', async () => {
 const source = await samplePdf();
 await assert.rejects(encryptPdfCopy({bytes: source, password: 'short', PDFLib: L}), /at least 8 characters/);
 await assert.rejects(encryptPdfCopy({bytes: source, password: 'open-password-123', ownerPassword: 'short', PDFLib: L}), /at least 8 characters/);
 await assert.rejects(encryptPdfCopy({bytes: source, password: 'open-password-123', ownerPassword: 'open-password-123', PDFLib: L}), /different owner password/);
 const encrypted = await encryptPdfCopy({bytes: source, password: 'open-password-123', PDFLib: L});
 assert.match(decode(encrypted), /\/Encrypt/);
});

test('existing encrypted and digitally signed PDFs are not rewritten', async () => {
 const source = await samplePdf();
 const encrypted = await encryptPdfCopy({bytes: source, password: 'open-password-123', PDFLib: L});
 await assert.rejects(encryptPdfCopy({bytes: encrypted, password: 'second-password-123', PDFLib: L}), /already encrypted|password protected/i);
 const signed = await samplePdf({signed: true});
 await assert.rejects(encryptPdfCopy({bytes: signed, password: 'open-password-123', PDFLib: L}), /digital signature/);
 await assert.rejects(encryptPdfCopy({
  bytes: signed, password: 'open-password-123', PDFLib: L,
  metadataFile: metadataFile({Title: 'Must not bypass'}),
 }), /digital signature/);
});
