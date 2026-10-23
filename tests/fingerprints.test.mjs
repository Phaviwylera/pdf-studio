import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {exportNativePdf} from '../dist/native-export.mjs';
import {pdfHeaderVersion, withHeaderVersion, ensureCatalogVersion, ensurePdfVersion, AES_256_MIN_VERSION} from '../dist/pdf-version.mjs';
import {readFile} from 'node:fs/promises';
import {buildDocumentFontInventory} from '../dist/font-inventory.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
globalThis.PDFLib = L; // the browser bundle sets this before app modules load
const {encryptPdfCopy} = await import('../dist/encrypt.mjs');
const fontkit = require('../dist/vendor/fontkit.umd.min.js');
const liberation = new Uint8Array(await readFile(new URL('../dist/vendor/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));

const name = key => L.PDFName.of(key);
const latin1 = bytes => new TextDecoder('latin1').decode(bytes);

test('a 1.4 header is raised to 1.7 without moving any byte', () => {
 const bytes = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
 const raised = withHeaderVersion(bytes, AES_256_MIN_VERSION);
 assert.equal(pdfHeaderVersion(bytes), '1.4');
 assert.equal(pdfHeaderVersion(raised), '1.7');
 assert.equal(raised.length, bytes.length, 'the header keeps its length, so offsets stay valid');
 assert.equal(latin1(raised).slice(9), latin1(bytes).slice(9));
});

test('a current header is left alone and an unreadable one is not rewritten', () => {
 const modern = new TextEncoder().encode('%PDF-1.7\n');
 assert.equal(withHeaderVersion(modern, '1.7'), modern, 'the same array is returned when nothing changes');
 const broken = new TextEncoder().encode('not a pdf');
 assert.equal(withHeaderVersion(broken, '1.7'), broken);
 assert.equal(pdfHeaderVersion(new Uint8Array([1, 2, 3])), null);
});

test('the catalog /Version is raised only when it is behind', async () => {
 const pdf = await L.PDFDocument.create();
 pdf.catalog.set(name('Version'), name('1.4'));
 pdf.addPage([200, 200]);
 assert.equal(ensureCatalogVersion(pdf, '1.7', L), true);
 assert.equal(pdf.catalog.get(name('Version')).toString(), '/1.7');
 assert.equal(ensureCatalogVersion(pdf, '1.7', L), false);

 const plain = await L.PDFDocument.create();
 assert.equal(ensureCatalogVersion(plain, '1.7', L), false, 'an absent entry is not invented');
 assert.equal(ensurePdfVersion({document: pdf, version: '1.7', L}), undefined, 'no bytes to patch');
});

test('AES-256 writes a 1.7 header and a 1.7 catalog version for a 1.4 original', async () => {
 const pdf = await L.PDFDocument.create();
 pdf.catalog.set(name('Version'), name('1.4'));
 pdf.addPage([300, 200]).drawText('Statement text', {x: 24, y: 140});
 const original = await pdf.save();
 assert.equal(pdfHeaderVersion(original), '1.7', 'pdf-lib writes a 1.7 header');
 const legacy = original.slice();
 legacy.set(new TextEncoder().encode('1.4'), 5); // pretend the source was a 1.4 file
 assert.equal(pdfHeaderVersion(legacy), '1.4');

 const encrypted = await encryptPdfCopy({bytes: legacy, password: 'open-password-123', PDFLib: L});
 assert.equal(pdfHeaderVersion(encrypted), '1.7');
 const reopened = await L.PDFDocument.load(encrypted, {ignoreEncryption: true, updateMetadata: false});
 assert.equal(reopened.catalog.get(name('Version')).toString(), '/1.7');
 assert.match(latin1(encrypted), /\/AESV3/, 'AES-256 is still the encryption used');
});

test('a blank owner password becomes a distinct generated one with read-only permissions', async () => {
 const pdf = await L.PDFDocument.create();
 pdf.addPage([300, 200]).drawText('Statement text', {x: 24, y: 140});
 const bytes = await pdf.save();
 let seen = null;
 await encryptPdfCopy({
  bytes, password: 'open-password-123', PDFLib: L,
  encrypt: async (output, password, options) => { seen = {output, password, options}; return output; },
 });
 assert.ok(seen, 'the encryptor received the document');
 assert.notEqual(seen.options.ownerPassword, seen.password, 'the open password never doubles as owner');
 assert.ok(seen.options.ownerPassword.length >= 8);
 assert.equal(seen.options.allowModifying, false);
 assert.equal(seen.options.allowPrinting, true);
 assert.equal(seen.options.allowCopying, true);
});

async function pageFixture() {
 const pdf = await L.PDFDocument.create();
 const font = await pdf.embedFont(L.StandardFonts.Helvetica);
 pdf.addPage([300, 200]).drawText('hello', {x: 30, y: 150, size: 12, font});
 return pdf.save();
}

function block(overrides = {}) {
 return {
  id: '1:0', page: 1, text: 'hello', x: 30, y: 150, size: 12, width: 60, height: 12,
  fontName: 'Helvetica', fontId: 'g_d0_f1', font: 'original',
  bold: false, italic: false, underline: false, spacing: 0, wordSpacing: 0, lineheight: 1.2,
  align: 'left', scaleX: 1, textMode: 0, strokeWidth: 1, color: '#000000', strokeColor: '#000000',
  ops: [0], canEdit: true, ...overrides,
 };
}

function glyphs(text) {
 return [...text].map(char => ({originalCharCode: char.codePointAt(0), unicode: char, width: 600, isSpace: false}));
}

function pageData(blockText = 'hello', blocks = null) {
 return async () => ({
  vp: {transform: [1, 0, 0, -1, 0, 200]},
  info: {ops: [{
   index: 0, str: blockText, fontId: 'g_d0_f1', font: {fontMatrix: [0.001, 0, 0, 0.001, 0, 0]},
   color: '#000000', mode: 0, pattern: false, glyphs: glyphs(blockText),
  }]},
  blocks: blocks ?? [block({text: blockText})],
 });
}

async function content(pdf) {
 const stream = pdf.context.lookup(pdf.getPage(0).node.get(name('Contents')));
 return latin1(L.decodePDFRawStream(stream).decode());
}

test('deleting text removes the showing operation instead of leaving a spacing trace', async () => {
 const original = await pageFixture();
 const removed = block({removed: true});
 const exported = await exportNativePdf({original, edits: new Map([[removed.id, removed]]), getPage: pageData(), PDFLib: L});
 const pdf = await L.PDFDocument.load(exported, {updateMetadata: false});
 const text = await content(pdf);
 assert.doesNotMatch(text, /\bTj\b/, 'no text is shown');
 assert.doesNotMatch(text, /\[\s*-?\d+(?:\.\d+)?\s*\]\s*TJ/, 'no spacing-only TJ is left behind');
 assert.doesNotMatch(latin1(exported), /PSEditFont|PSDocFont/);
});

test('an unchanged-style edit is written into the original operation', async () => {
 const original = await pageFixture();
 const edited = block({text: 'hell'});
 const exported = await exportNativePdf({
  original, edits: new Map([[edited.id, edited]]), getPage: pageData('hello', [block({text: 'hello'})]), PDFLib: L,
 });
 const pdf = await L.PDFDocument.load(exported, {updateMetadata: false});
 const text = await content(pdf);
 assert.match(text, /\[<68656C6C> -?\d+(?:\.\d+)?\] TJ/, 'the glyphs stay in the original text object');
 assert.doesNotMatch(text, /\bq\nq\n/, 'no extra graphics-state wrapper is added');
 const fonts = pdf.getPage(0).node.Resources().lookup(name('Font'), L.PDFDict);
 assert.equal([...fonts.entries()].length, 1, 'no second font resource is registered');
 assert.doesNotMatch(latin1(exported), /PSEditFont|PSDocFont/);
});

test('a style change is still rewritten inside the original text object', async () => {
 const original = await pageFixture();
 const edited = block({size: 18, color: '#AA0000', x: 40, y: 120});
 const exported = await exportNativePdf({
  original, edits: new Map([[edited.id, edited]]), getPage: pageData('hello', [block({text: 'hello'})]), PDFLib: L,
 });
 const pdf = await L.PDFDocument.load(exported, {updateMetadata: false});
 const text = await content(pdf);
 // The new size, colour and position live in the original text object.
 assert.match(text, /\/\S+ 18 Tf/);
 assert.match(text, /0\.6666667 0 0 rg/);
 assert.equal((text.match(/\bBT\b/g) || []).length, 1, 'no second text object is added');
 assert.equal((text.match(/\bq\b/g) || []).length, 1, 'no extra graphics-state wrapper');
 assert.doesNotMatch(text, /\[\s*-?\d+(?:\.\d+)?\s*\]\s*TJ/, 'no spacing-only TJ is left behind');
 const fonts = pdf.getPage(0).node.Resources().lookup(name('Font'), L.PDFDict);
 assert.equal([...fonts.entries()].length, 1, 'the page keeps its single font resource');
 assert.doesNotMatch(latin1(exported), /PSEditFont|PSDocFont/);
});

test('a native export carries no source descriptors and no provenance attachment', async () => {
 const original = await pageFixture();
 const out = await exportNativePdf({
  original, edits: new Map([['1:0', block({text: 'hell'})]]),
  getPage: pageData('hello', [block({text: 'hello'})]), PDFLib: L,
  metadataRecord: {schema: 'pdf-studio/source-metadata/v1', source: {filename: 'statement.pdf'}},
 });
 const pdf = await L.PDFDocument.load(out, {updateMetadata: false});
 const info = pdf.context.trailerInfo.Info && pdf.context.lookup(pdf.context.trailerInfo.Info, L.PDFDict);
 const keys = info ? [...info.keys()].map(key => key.toString()) : [];
 assert.deepEqual(keys.filter(key => /^\/Source/i.test(key)), []);
 assert.equal(pdf.catalog.get(name('Names')), undefined, 'no embedded files');
 assert.equal(latin1(out).includes('pdf-studio-source-metadata'), false);
 assert.doesNotMatch(latin1(out), /PSEditFont|PSDocFont/);
});

test('reusing a document font never embeds a second copy of the typeface', async () => {
 const pdf = await L.PDFDocument.create();
 pdf.registerFontkit(fontkit);
 const font = await pdf.embedFont(liberation, {subset: true});
 pdf.addPage([300, 200]).drawText('Hello world', {x: 20, y: 150, size: 12, font});
 pdf.addPage([300, 200]).drawText('Second page', {x: 20, y: 150, size: 12, font});
 const original = await pdf.save({useObjectStreams: true, addDefaultPage: false});
 const inventory = await buildDocumentFontInventory(original, L);
 const {resourceName} = inventory.pages[0].fonts[0];
 const edited = block({
  id: '2:added', page: 2, text: 'Hello word', font: 'PdfFontTest', fontName: inventory.fonts[0].baseFont,
  x: 20, y: 100, lineheight: 1.2, ops: [], added: true,
 });
 const exported = await exportNativePdf({
  original, edits: new Map([[edited.id, edited]]),
  getPage: async () => ({info: {ops: []}, vp: {transform: [1, 0, 0, 1, 0, 0]}}),
  documentFonts: new Map([['PdfFontTest', {page: 1, resourceName}]]),
  fontkit, PDFLib: L,
 });
 const output = await L.PDFDocument.load(exported, {updateMetadata: false});
 const programs = [...output.context.enumerateIndirectObjects()].filter(([, object]) => object instanceof L.PDFDict && (object.get(name('FontFile2')) || object.get(name('FontFile3')) || object.get(name('FontFile'))));
 assert.equal(programs.length, 1, 'one font program for the typeface, exactly as in the source');
 const baseFonts = pdf => [...pdf.context.enumerateIndirectObjects()]
  .filter(([, object]) => object instanceof L.PDFDict && object.get(name('BaseFont')))
  .map(([, object]) => object.get(name('BaseFont')).toString())
  .sort();
 const source = await L.PDFDocument.load(original, {updateMetadata: false});
 assert.deepEqual(baseFonts(output), baseFonts(source), 'the same single typeface, with no added subset');
 assert.doesNotMatch(latin1(exported), /PSEditFont|PSDocFont/);
});
