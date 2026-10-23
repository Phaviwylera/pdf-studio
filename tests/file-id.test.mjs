import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {
 hexFromBytes, scanPdfFileId, readPdfFileId, fileIdFromDocument, applyFileId,
 sameFileId, fileIdKey, fileIdStatus, fileIdWarning, enforceFileId,
} from '../dist/file-id.mjs';
import {exportNativePdf} from '../dist/native-export.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
globalThis.PDFLib = L; // Browser bundle exposes the same UMD global before app modules load.
const {encryptPdfCopy} = await import('../dist/encrypt.mjs');

const PERMANENT = '00112233445566778899AABBCCDDEEFF';
const CHANGING = 'FFEEDDCCBBAA99887766554433221100';
const OTHER = '0123456789ABCDEF0123456789ABCDEF';

async function pdfWithId({permanent = PERMANENT, changing = CHANGING, literal = false} = {}) {
 const pdf = await L.PDFDocument.create();
 pdf.addPage([200, 200]);
 const entry = hex => literal ? L.PDFString.of(String.fromCharCode(...hex.match(/../g).map(x => parseInt(x, 16)))) : L.PDFHexString.of(hex);
 pdf.context.trailerInfo.ID = pdf.context.obj([entry(permanent), entry(changing)]);
 return pdf.save({useObjectStreams: true, addDefaultPage: false});
}

function rawId(bytes) {
 const text = Buffer.from(bytes).toString('latin1');
 const match = text.match(/\/ID\s*\[[^\]]*\]/);
 return match ? match[0] : '';
}

test('readPdfFileId returns the exact trailer pair and its encoding', async () => {
 const bytes = await pdfWithId();
 const id = await readPdfFileId(bytes, L);
 assert.equal(id.permanent, PERMANENT);
 assert.equal(id.changing, CHANGING);
 assert.equal(id.permanentType, 'hex');
 assert.equal(id.changingType, 'hex');
 assert.equal(id.count, 2);
});

test('literal /ID strings are preserved rather than converted to hex', async () => {
 const bytes = await pdfWithId({permanent: '6162636465666768696A6B6C6D6E6F70', changing: '7172737475767778797A303132333435', literal: true});
 const id = await readPdfFileId(bytes, L);
 assert.equal(id.permanent, '6162636465666768696A6B6C6D6E6F70');
 assert.equal(id.permanentType, 'literal');
 const doc = await L.PDFDocument.load(bytes, {updateMetadata: false});
 applyFileId(doc, id, L);
 const saved = await doc.save({useObjectStreams: true, addDefaultPage: false});
 assert.match(rawId(saved), /^\/ID \[ \(abcdefghijklmnop\) \(qrstuvwxyz012345\) \]$/);
});

test('scanPdfFileId reads raw trailers, including escaped literal strings', () => {
 const text = '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R /ID [ <0011> (abc\\(d\\)) ] >>\n%%EOF';
 const id = scanPdfFileId(new TextEncoder().encode(text));
 assert.equal(id.permanent, '0011');
 assert.equal(id.changing, hexFromBytes(new TextEncoder().encode('abc(d)')));
 assert.equal(id.changingType, 'literal');
});

test('a document save keeps the source /ID without extra work', async () => {
 const bytes = await pdfWithId();
 const doc = await L.PDFDocument.load(bytes, {updateMetadata: false});
 const saved = await doc.save({useObjectStreams: true, addDefaultPage: false});
 assert.ok(sameFileId(fileIdFromDocument(doc, L), await readPdfFileId(saved, L)));
});

test('exportNativePdf restores the uploaded original pair after a decrypt-style rewrite', async () => {
 const original = await pdfWithId();
 const originalId = await readPdfFileId(original, L);
 // qpdf --decrypt keeps the permanent identifier and replaces the changing one.
 const rewritten = await L.PDFDocument.load(original, {updateMetadata: false});
 rewritten.context.trailerInfo.ID = rewritten.context.obj([
  L.PDFHexString.of(PERMANENT), L.PDFHexString.of(OTHER),
 ]);
 const working = await rewritten.save({useObjectStreams: true, addDefaultPage: false});
 assert.equal((await readPdfFileId(working, L)).changing, OTHER);

 const exported = await exportNativePdf({
  original: working, edits: new Map(), getPage: () => { throw new Error('no page needed'); },
  PDFLib: L, fileId: originalId,
 });
 const id = await readPdfFileId(exported, L);
 assert.equal(id.permanent, PERMANENT);
 assert.equal(id.changing, CHANGING);
 assert.equal(fileIdStatus(originalId, id), 'preserved');
});

test('exportNativePdf leaves an untouched no-edit export byte-identical', async () => {
 const bytes = await pdfWithId();
 const exported = await exportNativePdf({original: bytes, edits: new Map(), getPage: () => {}, PDFLib: L});
 assert.deepEqual(exported, bytes);
});

test('enforceFileId repairs an export that ignored the requested pair', async () => {
 const bytes = await pdfWithId({permanent: PERMANENT, changing: OTHER});
 const target = {permanent: PERMANENT, changing: CHANGING};
 const result = await enforceFileId({bytes, fileId: target, PDFLib: L});
 assert.equal(result.status, 'preserved');
 assert.equal(result.repaired, true);
 assert.equal((await readPdfFileId(result.bytes, L)).changing, CHANGING);

 const untouched = await enforceFileId({bytes: result.bytes, fileId: target, PDFLib: L});
 assert.equal(untouched.repaired, false);
 assert.deepEqual(untouched.bytes, result.bytes);
});

test('file id comparison and warnings describe every state', () => {
 const a = {permanent: PERMANENT, changing: CHANGING};
 const b = {permanent: PERMANENT, changing: OTHER};
 assert.equal(fileIdKey(a), `${PERMANENT}:${CHANGING}`);
 assert.ok(sameFileId(a, {...a}));
 assert.ok(!sameFileId(a, b));
 assert.equal(fileIdStatus(a, {...a}), 'preserved');
 assert.equal(fileIdStatus(a, b), 'changed');
 assert.equal(fileIdStatus(a, null), 'missing');
 assert.equal(fileIdStatus(null, a), 'source-missing');
 assert.equal(fileIdStatus(null, null), 'none');
 assert.match(fileIdWarning(a, b), /does not match/);
 assert.match(fileIdWarning(a, null), /has no \/ID/);
 assert.equal(fileIdWarning(a, {...a}), '');
 assert.equal(fileIdWarning(null, null), '');
});

test('AES-256 encryption keeps the source /ID pair', async () => {
 if (!globalThis.crypto?.subtle) return;
 const bytes = await pdfWithId();
 const encrypted = await encryptPdfCopy({
  bytes, password: 'correct horse battery', PDFLib: L,
 });
 const id = await readPdfFileId(encrypted, L);
 assert.equal(id.permanent, PERMANENT);
 assert.equal(id.changing, CHANGING);
});

test('encryption can restore a pair the source file lost', async () => {
 if (!globalThis.crypto?.subtle) return;
 const pdf = await L.PDFDocument.create();
 pdf.addPage([200, 200]);
 const bytes = await pdf.save({useObjectStreams: true, addDefaultPage: false});
 assert.equal(await readPdfFileId(bytes, L), null);
 const target = {permanent: PERMANENT, changing: CHANGING};
 const encrypted = await encryptPdfCopy({bytes, password: 'correct horse battery', fileId: target, PDFLib: L});
 assert.ok(sameFileId(target, await readPdfFileId(encrypted, L)));
});
