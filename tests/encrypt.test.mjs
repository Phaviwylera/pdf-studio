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
  const encryptedPdf = await L.PDFDocument.load(encrypted, {ignoreEncryption: true, updateMetadata: false});
  assert.deepEqual(Object.keys(infoEntries(encryptedPdf)).sort(), ['/Project', '/Title']);
  assert.notEqual(encryptedPdf.catalog.get(key('Metadata')), undefined);
  assert.equal(encryptedPdf.catalog.get(key('Names')), undefined);
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
 const encryptedPdf = await L.PDFDocument.load(encrypted, {ignoreEncryption: true, updateMetadata: false});
 const keys = Object.keys(infoEntries(encryptedPdf));
 for (const field of ['/Title', '/Author', '/Producer', '/OriginalCustom']) assert.ok(keys.includes(field), `${field} is retained in the encrypted PDF`);
 assert.notEqual(encryptedPdf.catalog.get(key('Metadata')), undefined);
});

test('invalid metadata JSON is rejected before encryption', async () => {
 const source = await samplePdf();
 let encryptCalls = 0;
 const encrypt = async () => { encryptCalls++; return new Uint8Array(); };
 const attempt = (file) => encryptPdfCopy({bytes: source, password: 'open-password-123', PDFLib: L, metadataFile: file, encrypt});
 await assert.rejects(attempt(metadataFile({info: {Custom: {Profile: {id: 7}}}})), (error) => {
  assert.equal(error.metadataError, true);
  assert.match(error.message, /"info\.Custom\.Profile" must be text, a number, a boolean or a PDF name.*received an object/);
  return true;
 });
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

test('sidebar-style file metadata JSON is applied to the encrypted PDF', async () => {
 const source = await samplePdf();
 const sidecar = {
  file: {name: '62271XXXX_DownloadStatement_1792215212.pdf', sizeBytes: 583255, hashes: {'SHA-1': 'abc123', 'SHA-256': 'def456'}},
  metadata: {version: '1.4', pages: 15, encrypted: true, Producer: 'openhtmltopdf.com', CreationDate: "D:20261017110332+05'30'", decrypted: true},
 };
 let prepared = null;
 const encrypted = await encryptPdfCopy({
  bytes: source, password: 'open-password-123', PDFLib: L,
  metadataFile: metadataFile(sidecar),
  encrypt: captureEncrypt(bytes => { prepared = bytes; }),
 });
 const pdf = await L.PDFDocument.load(prepared, {updateMetadata: false});
 assert.equal(pdf.getProducer(), 'openhtmltopdf.com');
 assert.equal(pdf.getTitle(), undefined); // Omitted original Info fields are removed.
 assert.equal(infoEntries(pdf)['/SourcePageCount'], undefined);
 assert.equal(infoEntries(pdf)['/SourceEncrypted'], undefined);
 assert.equal(infoEntries(pdf)['/SourceFilename'], undefined);
 assert.equal(pdf.catalog.get(key('Names')), undefined);
 assert.match(decode(encrypted), /\/Encrypt/);
 const encryptedPdf = await L.PDFDocument.load(encrypted, {ignoreEncryption: true, updateMetadata: false});
 assert.equal(infoEntries(encryptedPdf)['/SourceSHA256'], undefined, 'source descriptors are never written');
 assert.ok(Object.keys(infoEntries(encryptedPdf)).includes('/Producer'));
});

test('an RC4 128-bit copy writes the legacy security handler', async () => {
 const source = await samplePdf();
 const encrypted = await encryptPdfCopy({bytes: source, password: 'open sesame', ownerPassword: 'owner secret', PDFLib: L, algorithm: 'RC4-128'});
 const pdf = await L.PDFDocument.load(encrypted, {ignoreEncryption: true});
 const dict = pdf.context.lookup(pdf.context.trailerInfo.Encrypt, L.PDFDict);
 assert.equal(dict.get(key('Filter')).toString(), '/Standard');
 assert.equal(dict.get(key('V')).asNumber(), 2, 'V 2 is the RC4 handler');
 assert.equal(dict.get(key('R')).asNumber(), 3, 'R 3 is the 128-bit revision');
 assert.equal(dict.get(key('Length')).asNumber(), 128);
 // Both values are 32 bytes (R 3), written as hex strings with their brackets.
 assert.equal(dict.get(key('O')).toString().length, 66);
 assert.equal(dict.get(key('U')).toString().length, 66);
 // No AES-specific entries: /OE, /UE, /Perms and /CF belong to AES-256 only.
 for (const name of ['OE', 'UE', 'Perms', 'CF', 'StmF', 'StrF']) assert.equal(dict.get(key(name)), undefined, `${name} is not part of RC4`);
});

test('an RC4 128-bit copy is unreadable without the password', async () => {
 const source = await samplePdf();
 const encrypted = await encryptPdfCopy({bytes: source, password: 'open sesame', PDFLib: L, algorithm: 'RC4-128'});
 await assert.rejects(() => L.PDFDocument.load(encrypted), /encrypt|password/i);
 // The page text is inside the encrypted streams, not sitting in the bytes.
 assert.equal(decode(encrypted).includes('Private document'), false);
});

test('RC4 does not raise a document that already declares an older version', async () => {
 const source = await samplePdf();
 const lowered = await L.PDFDocument.load(source, {updateMetadata: false});
 lowered.catalog.set(key('Version'), L.PDFName.of('1.4'));
 const bytes = await lowered.save({useObjectStreams: false});
 const rc4 = await encryptPdfCopy({bytes, password: 'open sesame', PDFLib: L, algorithm: 'RC4-128'});
 const after = await L.PDFDocument.load(rc4, {ignoreEncryption: true});
 assert.equal(after.catalog.get(key('Version'))?.toString(), '/1.4', 'RC4 128-bit is defined from 1.4 on');
 // AES-256 still raises it, so the file never claims to be older than its encryption.
 const aes = await encryptPdfCopy({bytes, password: 'open sesame', PDFLib: L});
 const raised = await L.PDFDocument.load(aes, {ignoreEncryption: true});
 assert.equal(raised.catalog.get(key('Version'))?.toString(), '/1.7');
});

test('the algorithm reaches the encryptor from the export path and is validated', async () => {
 const calls = [];
 const encrypt = async (bytes, password, options) => { calls.push(options.algorithm); return new Uint8Array([1, 2, 3]); };
 await encryptPdfCopy({bytes: await samplePdf(), password: 'open sesame', PDFLib: L, algorithm: 'RC4-128', encrypt});
 await encryptPdfCopy({bytes: await samplePdf(), password: 'open sesame', PDFLib: L, encrypt});
 assert.deepEqual(calls, ['RC4', 'AES-256']);
 await assert.rejects(() => encryptPdfCopy({bytes: new Uint8Array([1]), password: 'open sesame', PDFLib: L, algorithm: 'DES'}), /AES-256 or RC4 128-bit/);
});

test('an encrypted copy keeps the header marker of the copy it came from', async () => {
 const source = await samplePdf();
 // Pretend the opened document came from the bank: PDFBox's binary marker.
 const bank = Uint8Array.from(source);
 const at = Buffer.from(bank).indexOf(Buffer.from([0x25, 0x81, 0x81, 0x81, 0x81]));
 assert.ok(at > 0, 'the fixture is a pdf-lib file, so it carries the library marker');
 bank.set([0x25, 0xe2, 0xe3, 0xcf, 0xd3], at);
 // /ID and the owner-key entries are randomised per save, so lengths vary between
 // runs; record what the encryptor itself produced and compare against that.
 let written = 0;
 const measuring = async (bytes, password, options) => {
  const out = await encryptPDF(bytes, password, options);
  written = out.length;
  return out;
 };
 const encryptWith = (bytes) => encryptPdfCopy({
  bytes, password: 'open sesame', ownerPassword: 'owner password', algorithm: 'RC4-128',
  PDFLib: L, onProgress: () => {}, encrypt: measuring,
 });
 for (const [label, input] of [['bank', bank], ['library', source]]) {
  const out = await encryptWith(input);
  const head = Buffer.from(out).subarray(0, 14).toString('latin1');
  if (label === 'bank') {
   assert.equal(head, '%PDF-1.7\n%\xE2\xE3\xCF\xD3', 'the encrypted copy names the producer, not this library');
   assert.ok(!Buffer.from(out).subarray(0, 64).includes(0x81), 'no 0x81 marker survives encryption');
  } else {
   assert.equal(head, '%PDF-1.7\n%\x81\x81\x81\x81', 'a library file keeps its own marker');
  }
  // Encryption is a second save; the marker is swapped for one of the same size,
  // so every offset the encryptor wrote still points at the object it described.
  assert.equal(out.length, written, `${label}: alignment never shifts a byte`);
  const text = Buffer.from(out).toString('latin1');
  const xref = Number(/startxref\s+(\d+)/.exec(text)[1]);
  assert.match(text.slice(xref, xref + 40), /^(xref|\d+ 0 obj)/, `${label}: startxref still points at the cross-reference`);
 }
});
