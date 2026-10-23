import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {exportNativePdf} from '../dist/native-export.mjs';
import {METADATA_ATTACHMENT, makeSourceMetadataRecord, metadataJson, capturePdfMetadata, restorePdfMetadata} from '../dist/metadata.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
const name = key => L.PDFName.of(key);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function fixture() {
 const pdf = await L.PDFDocument.create();
 pdf.setTitle('Original title');
 pdf.setAuthor('Original author');
 pdf.setProducer('Original producer');
 pdf.setCreationDate(new Date('2020-01-02T03:04:05Z'));
 pdf.setModificationDate(new Date('2020-05-06T07:08:09Z'));
 pdf.context.lookup(pdf.context.trailerInfo.Info, L.PDFDict).set(name('CustomSourceKey'), L.PDFHexString.fromText('keep this too'));
 const xml = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><original>keep XMP</original></x:xmpmeta>';
 pdf.catalog.set(name('Metadata'), pdf.context.register(pdf.context.flateStream(encoder.encode(xml), {Type: 'Metadata', Subtype: 'XML'})));
 pdf.addPage([300, 200]).drawText('Existing text', {x: 30, y: 150});
 return {bytes: await pdf.save(), xml};
}

function infoEntries(pdf) {
 const dict = pdf.context.lookup(pdf.context.trailerInfo.Info, L.PDFDict);
 return Object.fromEntries([...dict.entries()].map(([key, value]) => [key.toString(), value.toString()]));
}

function xmpXml(pdf) {
 const stream = pdf.context.lookup(pdf.catalog.get(name('Metadata')));
 return decoder.decode(L.decodePDFRawStream(stream).decode());
}

function attachment(pdf, filename) {
 const names = pdf.catalog.lookup(name('Names'), L.PDFDict).lookup(name('EmbeddedFiles'), L.PDFDict).lookup(name('Names'), L.PDFArray);
 for (let i = 0; i < names.size(); i += 2) {
  if (names.get(i).decodeText() !== filename) continue;
  const spec = pdf.context.lookup(names.get(i + 1), L.PDFDict);
  const stream = pdf.context.lookup(spec.lookup(name('EF'), L.PDFDict).get(name('F')));
  return decoder.decode(L.decodePDFRawStream(stream).decode());
 }
 return null;
}

function newText(text) {
 return new Map([['1:new', {
  id: '1:new', added: true, page: 1, text, x: 42, y: 42, size: 12,
  font: 'Arial', bold: false, italic: false, color: '#112233', spacing: 0,
  lineheight: 1.2, align: 'left', scaleX: 1, ops: [],
 }]]);
}

const getPage = async () => ({vp: {transform: [1, 0, 0, -1, 0, 200]}, info: {ops: []}});
const record = makeSourceMetadataRecord({
 filename: 'uploaded.pdf', byteLength: 500, pageCount: 1,
 inspection: {locked: false, unknown: false},
 metadata: {
  info: {PDFFormatVersion: '1.7', IsLinearized: false, Language: 'en', Title: 'Original title', Producer: 'Original producer', Custom: {CustomSourceKey: 'keep this too'}},
  metadata: {getRaw: () => '<xmp>original</xmp>', [Symbol.iterator]: function* () { yield ['dc:title', 'Original title']; }},
 },
});

test('source report distinguishes uploaded metadata from export authenticity', () => {
 assert.equal(record.source.encryption, 'not detected');
 assert.deepEqual(Object.keys(record.info), ['Title', 'Producer', 'Custom']);
 assert.equal(record.xmp.raw, '<xmp>original</xmp>');
 assert.equal(record.xmp.fields['dc:title'], 'Original title');
 assert.match(record.note, /not a digital signature/);
 assert.deepEqual(JSON.parse(metadataJson(record)), record);
 const unavailable = makeSourceMetadataRecord({filename: 'locked.pdf', byteLength: 100, pageCount: 1, inspection: {unknown: true, reason: 'encrypted'}});
 assert.equal(unavailable.source.encryption, 'encrypted');
 assert.equal(unavailable.available, false);
});

test('metadata restore preserves custom Info fields and the original XMP reference', async () => {
 const {bytes} = await fixture();
 const pdf = await L.PDFDocument.load(bytes, {updateMetadata: false});
 const expected = infoEntries(pdf);
 const saved = capturePdfMetadata(pdf, L);
 pdf.setProducer('accidental replacement');
 pdf.catalog.delete(name('Metadata'));
 restorePdfMetadata(pdf, L, saved);
 const out = await L.PDFDocument.load(await pdf.save(), {updateMetadata: false});
 assert.deepEqual(infoEntries(out), expected);
 assert.match(xmpXml(out), /keep XMP/);
});

test('no-edit export is byte-for-byte unchanged, without any attachment', async () => {
 const {bytes} = await fixture();
 const result = await exportNativePdf({original: bytes, edits: new Map(), PDFLib: L, metadataRecord: record});
 assert.deepEqual(result, bytes);
});

test('edited export retains original Info/XMP without a provenance attachment', async () => {
 const {bytes, xml} = await fixture();
 const before = await L.PDFDocument.load(bytes, {updateMetadata: false});
 const out = await exportNativePdf({original: bytes, edits: newText('New text'), PDFLib: L, metadataRecord: record, getPage});
 assert.notDeepEqual(out, bytes);
 const after = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.deepEqual(infoEntries(after), infoEntries(before));
 assert.equal(xmpXml(after), xml);
 // An embedded source record makes the file look like a re-saved copy, so the
 // export carries none unless the caller explicitly opts in.
 assert.equal(after.catalog.get(name('Names')), undefined);
 assert.equal(decoder.decode(out).includes('pdf-studio-source-metadata'), false);
 assert.equal(after.getPageCount(), 1);
});

test('the provenance attachment is only written when explicitly requested', async () => {
 const {bytes} = await fixture();
 const out = await exportNativePdf({original: bytes, edits: newText('New text'), PDFLib: L, metadataRecord: record, getPage, attachProvenance: true});
 const after = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.equal(attachment(after, METADATA_ATTACHMENT), metadataJson(record));
});

test('editing a PDF without Info or XMP does not invent either metadata field', async () => {
 const pdf = await L.PDFDocument.create();
 delete pdf.context.trailerInfo.Info;
 pdf.addPage([300, 200]);
 const original = await pdf.save();
 const out = await exportNativePdf({original, edits: newText('Added'), PDFLib: L, metadataRecord: record, getPage});
 const edited = await L.PDFDocument.load(out, {updateMetadata: false});
 assert.equal(edited.context.trailerInfo.Info, undefined);
 assert.equal(edited.catalog.get(name('Metadata')), undefined);
 assert.equal(edited.catalog.get(name('Names')), undefined);
});

test('re-editing an opted-in provenance attachment uses a distinct attachment name', async () => {
 const {bytes} = await fixture();
 const first = await exportNativePdf({original: bytes, edits: newText('First'), PDFLib: L, metadataRecord: record, getPage, attachProvenance: true});
 const secondRecord = {...record, source: {...record.source, filename: 'first-edited.pdf'}};
 const second = await exportNativePdf({original: first, edits: newText('Second'), PDFLib: L, metadataRecord: secondRecord, getPage, attachProvenance: true});
 const pdf = await L.PDFDocument.load(second, {updateMetadata: false});
 assert.equal(attachment(pdf, METADATA_ATTACHMENT), metadataJson(record));
 assert.equal(attachment(pdf, 'pdf-studio-source-metadata-2.json'), metadataJson(secondRecord));
});
