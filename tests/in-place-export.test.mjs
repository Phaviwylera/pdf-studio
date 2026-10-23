import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {exportNativePdf} from '../dist/native-export.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
const latin1 = bytes => new TextDecoder('latin1').decode(bytes);
const name = key => L.PDFName.of(key);

// Widths close to a real font, so a longer value is genuinely wider.
const WIDTHS = {'.': 250, ',': 250, '(': 333, ')': 333, 'D': 722, 'r': 333, 'C': 722, ' ': 278};

// The page carries the cell plus a strip of every character a statement cell can
// hold, the way a real page does: the font's code map comes from the whole page.
const ALPHABET = '0123456789.,()DrC ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

async function statementPage(text, {x = 150, y = 150, size = 9} = {}) {
 const pdf = await L.PDFDocument.create();
 const font = await pdf.embedFont(L.StandardFonts.Helvetica);
 const page = pdf.addPage([300, 200]);
 page.drawText(text, {x, y, size, font});
 page.drawText(ALPHABET, {x: 20, y: 20, size, font});
 return {bytes: await pdf.save(), width: font.widthOfTextAtSize(text, size), x, y, size};
}

function glyphs(text) {
 return [...text].map(char => ({
  originalCharCode: char.codePointAt(0), unicode: char,
  width: WIDTHS[char] ?? 600, isSpace: false,
 }));
}

// pdf-lib draws in PDF coordinates; the editor's blocks are viewport coordinates,
// which grow downwards from the top of a 200pt page.
const viewY = pdfY => 200 - pdfY;

function block(fixture, overrides = {}) {
 return {
  id: '1:0', page: 1, text: fixture.text, x: fixture.x, y: viewY(fixture.y), size: fixture.size,
  width: fixture.width, height: fixture.size, fontName: 'Helvetica', fontId: 'g_d0_f1', font: 'original',
  bold: false, italic: false, underline: false, spacing: 0, wordSpacing: 0, lineheight: 1.2,
  align: 'left', scaleX: 1, textMode: 0, strokeWidth: 1, color: '#000000', strokeColor: '#000000',
  ops: [0], canEdit: true, ...overrides,
 };
}

const op = (index, text) => ({
 index, str: text, fontId: 'g_d0_f1', font: {fontMatrix: [0.001, 0, 0, 0.001, 0, 0]},
 color: '#000000', mode: 0, pattern: false, glyphs: glyphs(text),
});

function pageData(fixture, blocks) {
 return async () => ({
  vp: {transform: [1, 0, 0, -1, 0, 200]},
  info: {ops: [op(0, fixture.text), op(1, ALPHABET)]},
  blocks,
 });
}

async function exported(original, fixture, edit) {
 const bytes = await exportNativePdf({
  original, edits: new Map([[edit.id, edit]]), getPage: pageData(fixture, [block(fixture)]), PDFLib: L,
 });
 const pdf = await L.PDFDocument.load(bytes.slice(), {updateMetadata: false});
 const stream = pdf.context.lookup(pdf.getPage(0).node.get(name('Contents')));
 return {text: latin1(L.decodePDFRawStream(stream).decode()), bytes};
}

const matrices = text => [...text.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/g)]
 .map(match => match.slice(1, 7).map(Number));

test('an edited value is placed at its natural width, never squeezed into the old one', async () => {
 const original = await statementPage('100.00(Dr)');
 const fixture = {...original, text: '100.00(Dr)'};
 const edit = block(fixture, {text: '1000.00(Cr)', scaleX: 0.9998});

 const {text} = await exported(original.bytes, fixture, edit);
 const found = matrices(text);
 assert.equal(found.length, 2, 'the two text objects keep one matrix each: the cell\'s is reused, not duplicated');
 for (const [a, b, c, d] of found) {
  assert.equal(a, 1, 'no horizontal scale: the glyph advance decides the width');
  assert.equal(b, 0);
  assert.equal(c, 0);
  assert.equal(Math.abs(d), 1, 'the baseline is not flipped or scaled');
 }
 assert.doesNotMatch(text, /0\.9998/, 'the browser measurement correction is not written into the page');
 assert.doesNotMatch(text, /\d+ Tz/, 'no horizontal scaling operator');

 // The wider value starts further left so the money column keeps its right edge.
 const cell = found.find(matrix => Math.abs(matrix[5] - fixture.y) < 0.01);
 assert.ok(cell, 'the cell keeps its baseline');
 assert.ok(cell[4] < fixture.x, `expected a start left of ${fixture.x}, found ${cell[4]}`);
 const natural = (10 / 9) * fixture.width;
 assert.ok(Math.abs(cell[4] + natural - (fixture.x + fixture.width)) < 5, 'the column still ends where it did');
});

test('a value that gets shorter keeps the same right edge', async () => {
 const original = await statementPage('1000.00(Cr)');
 const fixture = {...original, text: '1000.00(Cr)'};
 const edit = block(fixture, {text: '9.00(Cr)'});
 const {text} = await exported(original.bytes, fixture, edit);
 const cell = matrices(text).find(matrix => Math.abs(matrix[5] - fixture.y) < 0.01);
 assert.equal(cell[0], 1);
 assert.ok(cell[4] > fixture.x, 'a narrower value starts further right');
});

test('an edit that keeps its width is written into the original operation', async () => {
 const original = await statementPage('202.00(Dr)');
 const fixture = {...original, text: '202.00(Dr)'};
 const edit = block(fixture, {text: '402.00(Dr)'});
 const {text} = await exported(original.bytes, fixture, edit);
 const found = matrices(text);
 assert.equal(found.length, 2, 'nothing moves, so the producer matrices are kept as they are');
 assert.deepEqual(found.find(matrix => Math.abs(matrix[5] - fixture.y) < 0.01), [1, 0, 0, 1, fixture.x, fixture.y], 'the cell sits where it always did');
 assert.match(text, /Tj/, 'the glyphs replace the original ones in place');
});

test('prose is left-aligned where it was and is not stretched', async () => {
 const original = await statementPage('NEFT transfer');
 const fixture = {...original, text: 'NEFT transfer'};
 const edit = block(fixture, {text: 'IMPS transfer to SNEHA'});
 const {text} = await exported(original.bytes, fixture, edit);
 for (const [a, b, c, d] of matrices(text)) {
  assert.equal(a, 1);
  assert.equal(b, 0);
  assert.equal(c, 0);
  assert.equal(Math.abs(d), 1);
 }
 const cell = matrices(text).find(matrix => Math.abs(matrix[5] - fixture.y) < 0.01);
 assert.ok(Math.abs(cell[4] - fixture.x) < 0.01, 'prose keeps its left edge');
});

test('a new block is drawn at natural width too', async () => {
 const original = await statementPage('Statement');
 const fixture = {...original, text: 'Statement'};
 const added = block(fixture, {id: '1:new', added: true, text: 'Added note', scaleX: 0.8, ops: []});
 const bytes = await exportNativePdf({
  original: original.bytes, edits: new Map([[added.id, added]]),
  getPage: async () => ({vp: {transform: [1, 0, 0, -1, 0, 200]}, info: {ops: []}}), PDFLib: L,
 });
 const pdf = await L.PDFDocument.load(bytes.slice(), {updateMetadata: false});
 const stream = pdf.context.lookup(pdf.getPage(0).node.get(name('Contents')));
 const text = latin1(L.decodePDFRawStream(stream).decode());
 const found = matrices(text);
 assert.ok(found.length >= 1);
 for (const [a, b, c, d] of found) {
  assert.equal(a, 1, 'the block scale is a preview correction, not a page property');
  assert.equal(b, 0);
  assert.equal(c, 0);
  assert.equal(Math.abs(d), 1);
 }
});
