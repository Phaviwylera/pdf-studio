import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {exportNativePdf} from '../dist/native-export.mjs';
import {MAX_USER_METADATA_BYTES, parseUploadedMetadata} from '../dist/metadata.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
const key = name => L.PDFName.of(name);
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder().decode(bytes);
const upload = (json, name = 'replacement.json') => parseUploadedMetadata(encode(json), name);

async function source() {
 const pdf = await L.PDFDocument.create();
 pdf.setTitle('First title');
 pdf.setAuthor('Original author');
 pdf.setProducer('First producer');
 pdf.setModificationDate(new Date('2020-01-02T03:04:05Z'));
 pdf.context.lookup(pdf.context.trailerInfo.Info, L.PDFDict).set(key('CustomField'), L.PDFHexString.fromText('original'));
 pdf.catalog.set(key('Metadata'), pdf.context.register(pdf.context.flateStream(encode('<x:xmpmeta xmlns:x="adobe:ns:meta/">Old XMP</x:xmpmeta>'), {Type: 'Metadata', Subtype: 'XML'})));
 pdf.addPage([200, 200]);
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

function assertOldMetadataNotRetained(pdf) {
 const oldTitle = L.PDFHexString.fromText('First title').toString();
 const oldAuthor = L.PDFHexString.fromText('Original author').toString();
 for (const [, object] of pdf.context.enumerateIndirectObjects()) {
  assert.equal(object.toString().includes(oldTitle) || object.toString().includes(oldAuthor), false);
  if (object instanceof L.PDFStream && object.dict.get(key('Type'))?.toString() === '/Metadata') {
   assert.equal(decode(L.decodePDFRawStream(object).decode()).includes('Old XMP'), false);
  }
 }
}

test('upload accepts native fields, dates and scalar custom values', () => {
 const parsed = upload('{"title":"Second title","Author":"Second author","CreationDate":"D:20200102030405Z","Custom":{"Project":"42","Version":3,"Ready":true},"Trapped":"False"}');
 assert.equal(parsed.byteLength > 0, true);
 assert.deepEqual(parsed.fields.map(x => x.key), ['Title', 'Author', 'CreationDate', 'Project', 'Version', 'Ready', 'Trapped']);
 assert.equal(parsed.fields.find(x => x.key === 'Version').type, 'number');
 assert.equal(parsed.xmpRaw, null);
});

test('source-metadata JSON can supply Info/XMP, but PDF structure properties are not metadata', () => {
 const report = {
  schema: 'pdf-studio/source-metadata/v1', note: 'source', source: {filename: 'old.pdf', bytes: 500, pages: 9}, available: true,
  info: {PDFFormatVersion: '1.7', IsLinearized: false, Title: 'From report', Trapped: {name: 'False'}, Custom: {Case: 'ABC'}},
  xmp: {fields: {'dc:title': 'From report'}, raw: '<x:xmpmeta xmlns:x="adobe:ns:meta/">New XMP</x:xmpmeta>'},
 };
 const parsed = upload(JSON.stringify(report));
 assert.deepEqual(parsed.ignored, ['PDFFormatVersion', 'IsLinearized']);
 assert.deepEqual(parsed.fields.map(x => x.key), ['Title', 'Trapped', 'Case']);
 assert.match(parsed.xmpRaw, /New XMP/);
});

test('bad or unsupported replacement metadata is rejected before export', () => {
 assert.throws(() => parseUploadedMetadata(encode('{}'), 'wrong.pdf'), /\.json/);
 assert.throws(() => parseUploadedMetadata(Uint8Array.of(0xff), 'bad.json'), /UTF-8 JSON object/);
 assert.throws(() => upload('[]'), /UTF-8 JSON object/);
 assert.throws(() => upload('{bad}'), /UTF-8 JSON object/);
 assert.throws(() => upload('{"info":{"Title":17}}'), /"info\.Title" must be text or a list of names; received a number/);
 assert.throws(() => upload('{"info":{"Custom":{"Nested":{"bad":1}}}}'), /must be text/);
 assert.throws(() => upload('{"info":{},"extra":"ignored"}'), /Unsupported metadata field/);
 assert.throws(() => upload('{"PDFFormatVersion":"1.7"}'), /structure property/);
 assert.throws(() => upload('{"xmp":{"fields":{"dc:title":"No XML"}}}'), /raw XML/);
 assert.throws(() => upload('{"xmp":"not XML"}'), /must be XML/);
 assert.throws(() => upload('{"xmp":"<!DOCTYPE x><x/>"}'), /document type/);
 assert.throws(() => upload('{"Title":"A","title":"B"}'), /Duplicate PDF Info/);
 assert.throws(() => upload('{"info":{"Custom":{"Profile":{"id":7,"name":"A"}}}}'), /"info\.Custom\.Profile" must be text, a number, a boolean or a PDF name.*received an object with keys "id", "name"/);
 assert.throws(() => upload('{"file":{"name":{"nested":1}}}'), /"file\.name" must be text, a number, a boolean or a PDF name.*received an object/);
 assert.throws(() => upload('{"info":{"Bad":{"a":1},"Worse":[1,2]}}'), /"info\.Bad".*"info\.Worse".*2 more PDF Info fields are unsupported|"info\.Bad".*"info\.Worse"/);
 const error = (() => { try { upload('{"info":{"Title":17}}'); } catch (e) { return e; } })();
 assert.equal(error.metadataError, true);
 assert.throws(() => parseUploadedMetadata(new Uint8Array(MAX_USER_METADATA_BYTES + 1), 'large.json'), /8 MB/);
});

test('lists of names are joined for standard text fields and unsupported lists are rejected', () => {
 const parsed = upload('{"Keywords":["one","two"],"Author":["Ada","Grace"],"Subject":[]}');
 assert.deepEqual(parsed.fields, [
  {key: 'Keywords', type: 'text', value: 'one, two'},
  {key: 'Author', type: 'text', value: 'Ada, Grace'},
  {key: 'Subject', type: 'text', value: ''},
 ]);
 assert.throws(() => upload('{"Custom":{"Tags":["a","b"]}}'), /"Custom\.Tags" must be text, a number, a boolean or a PDF name.*received an array of 2 items/);
});

test('metadata-only export replaces Info completely, removes omitted fields and XMP, and adds no attachment', async () => {
 const original = await source();
 const replacement = upload('{"Title":"Second title","Custom":{"Project":42}}');
 const out = await exportNativePdf({original, edits: new Map(), PDFLib: L, metadataRecord: {source: 'not attached'}, uploadedMetadata: replacement});
 assert.notDeepEqual(out, original);
 const pdf = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.deepEqual(Object.keys(infoEntries(pdf)).sort(), ['/Project', '/Title']);
 assert.equal(pdf.getTitle(), 'Second title');
 assert.equal(pdf.getAuthor(), undefined);
 assert.equal(pdf.getProducer(), undefined);
 assert.equal(xmpXml(pdf), null);
 assert.equal(pdf.catalog.get(key('Names')), undefined);
 assert.equal(pdf.getPageCount(), 1);
 assertOldMetadataNotRetained(pdf);
});

test('an omitted ModDate is removed rather than inherited from the original PDF', async () => {
 const original = await source(); // Includes an original /ModDate.
 const result = await exportNativePdf({original, edits: new Map(), PDFLib: L, uploadedMetadata: upload('{"Title":"Only this field"}')});
 const pdf = await L.PDFDocument.load(result, {updateMetadata: false});
 assert.deepEqual(Object.keys(infoEntries(pdf)), ['/Title']);
 assert.equal(pdf.getModificationDate(), undefined);
 for (const [, object] of pdf.context.enumerateIndirectObjects()) {
  if (object instanceof L.PDFDict) assert.equal(object.has(key('ModDate')), false);
 }
});

test('structured source report replaces Info/XMP, not page count or other PDF features', async () => {
 const original = await source();
 const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/">Updated XMP</x:xmpmeta>';
 const replacement = upload(JSON.stringify({schema: 'pdf-studio/source-metadata/v1', source: {pages: 17}, info: {
  PDFFormatVersion: '1.7', Title: 'Report title', Trapped: {name: 'False'}, Custom: {ClientNumber: 12, Valid: true},
 }, xmp: {fields: {}, raw: xml}}));
 const bytes = await exportNativePdf({original, edits: new Map(), PDFLib: L, uploadedMetadata: replacement});
 const pdf = await L.PDFDocument.load(bytes, {updateMetadata: false});
 assert.equal(pdf.getTitle(), 'Report title');
 assert.equal(xmpXml(pdf), xml);
 assert.deepEqual(Object.keys(infoEntries(pdf)).sort(), ['/ClientNumber', '/Title', '/Trapped', '/Valid']);
 assert.equal(pdf.getPageCount(), 1);
 assert.equal(pdf.catalog.get(key('Names')), undefined);
 assertOldMetadataNotRetained(pdf);
});

test('uploaded XMP can be added when the source has no metadata stream', async () => {
 const pdf = await L.PDFDocument.create();
 delete pdf.context.trailerInfo.Info;
 pdf.addPage([200, 200]);
 const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/">Only uploaded XMP</x:xmpmeta>';
 const original = await pdf.save();
 const out = await exportNativePdf({original, edits: new Map(), PDFLib: L, uploadedMetadata: upload(JSON.stringify({info: {}, xmp: {raw: xml}}))});
 const edited = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.deepEqual(infoEntries(edited), {});
 assert.equal(xmpXml(edited), xml);
});

test('text changes and metadata replacement are applied in one native export', async () => {
 const original = await source();
 const edits = new Map([['1:new', {
  id: '1:new', added: true, page: 1, text: 'New line', x: 35, y: 40,
  size: 12, font: 'Arial', bold: false, italic: false, color: '#000000',
  spacing: 0, lineheight: 1.2, align: 'left', scaleX: 1, ops: [],
 }]]);
 const out = await exportNativePdf({
  original, edits, PDFLib: L, metadataRecord: {note: 'must not attach'}, uploadedMetadata: upload('{"Subject":"Rewritten"}'),
  getPage: async () => ({vp: {transform: [1, 0, 0, -1, 0, 200]}, info: {ops: []}}),
 });
 const pdf = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.deepEqual(Object.keys(infoEntries(pdf)), ['/Subject']);
 assert.equal(xmpXml(pdf), null);
 assert.equal(pdf.catalog.get(key('Names')), undefined);
});

test('empty metadata object removes native Info and XMP altogether', async () => {
 const original = await source();
 const out = await exportNativePdf({original, edits: new Map(), PDFLib: L, uploadedMetadata: upload('{}')});
 const pdf = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.deepEqual(infoEntries(pdf), {});
 assert.equal(xmpXml(pdf), null);
 assertOldMetadataNotRetained(pdf);
});

test('replacement metadata cannot bypass signed-PDF protection', async () => {
 const pdf = await L.PDFDocument.create();
 pdf.addPage([200, 200]);
 const sig = pdf.context.register(pdf.context.obj({Type: 'Sig', ByteRange: [0, 1, 2, 3], Contents: L.PDFHexString.of('0000')}));
 pdf.catalog.set(key('TestSignature'), sig);
 const original = await pdf.save();
 await assert.rejects(exportNativePdf({original, edits: new Map(), PDFLib: L, uploadedMetadata: upload('{"Title":"New"}')}), /Signature protection/);
 assert.deepEqual(await exportNativePdf({original, edits: new Map(), PDFLib: L}), original);
});

// Shape of a typical downloader sidecar: source file details plus PDF properties.
const sidecar = {
 file: {
  name: '62271XXXX_DownloadStatement_1792215212.pdf',
  sizeBytes: 583255,
  hashes: {
   'SHA-1': 'e0cd0b32f7b3d19faac9055724e63d4344bc84b4',
   'SHA-256': '5ed8fb71a4dbbf699ffc40f1b2f27a250dd4fe02c0dfed1dd00b00b929ebde21',
  },
 },
 metadata: {
  version: '1.4', pages: 15, encrypted: true, Producer: 'openhtmltopdf.com',
  CreationDate: "D:20261017110332+05'30'", decrypted: true,
 },
};

test('sidecar file reports apply native Info fields and drop source descriptors', () => {
 const parsed = upload(JSON.stringify(sidecar));
 assert.equal(parsed.format, 'sidecar');
 // Only real PDF metadata is written. Source-side details (file name, size,
 // hashes, version, encryption) stay out of Info so the export is not a copy.
 assert.deepEqual(parsed.fields, [
  {key: 'Producer', type: 'text', value: 'openhtmltopdf.com'},
  {key: 'CreationDate', type: 'date', value: "D:20261017110332+05'30'"},
 ]);
 assert.equal(parsed.xmpRaw, null);
 assert.ok(parsed.ignored.includes('file.name'));
 assert.ok(parsed.ignored.includes('file.sizeBytes'));
 assert.ok(parsed.ignored.includes('file.hashes.SHA-256'));
 assert.ok(parsed.ignored.includes('metadata.version'));
});

test('sidecar values write only real Info fields, with no source descriptors', async () => {
 const original = await source();
 const out = await exportNativePdf({original, edits: new Map(), PDFLib: L, metadataRecord: {must: 'not attach'}, uploadedMetadata: upload(JSON.stringify(sidecar))});
 const pdf = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.equal(pdf.getProducer(), 'openhtmltopdf.com');
 const entries = infoEntries(pdf);
 assert.equal(entries['/SourcePageCount'], undefined);
 assert.equal(entries['/SourceEncrypted'], undefined);
 assert.equal(entries['/SourceFilename'], undefined);
 assert.equal(entries['/SourceSHA256'], undefined);
 assert.equal(Object.keys(entries).filter(key => /^\/Source/i.test(key)).length, 0, 'no Source* Info keys');
 assert.equal(pdf.catalog.get(key('Names')), undefined);
 assert.equal(xmpXml(pdf), null);
});

test('sidecar reports reject nested source file values with a precise field name', () => {
 assert.throws(() => upload('{"file":{"name":"a.pdf","hashes":{"SHA-256":{"hex":"x"}}}}'), /"file\.hashes\.SHA-256" must be text/);
 assert.throws(() => upload('{"file":{"name":"a.pdf","extra":{"nested":1}}}'), /"file\.extra" must be text, a number, a boolean or a PDF name/);
 assert.throws(() => upload('{"metadata":{"Profile":{"id":7}}}'), /"metadata\.Profile" must be text, a number, a boolean or a PDF name/);
});
