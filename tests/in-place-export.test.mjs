import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {exportNativePdf, documentHexEncoder} from '../dist/native-export.mjs';
import {alignHeader} from '../dist/header-marker.mjs';

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

async function exported(original, fixture, edit, blocks = [block(fixture)]) {
 const bytes = await exportNativePdf({
  original, edits: new Map([[edit.id, edit]]), getPage: pageData(fixture, blocks), PDFLib: L,
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

test('a rewritten cell keeps the producer\'s baseline, decimal for decimal', async () => {
 // A producer writes five decimals (715.08752); the preview only ever holds
 // three (715.088). Re-deriving the baseline from the preview is what leaves a
 // rounded coordinate in the page next to the untouched rows.
 const original = await statementPage('100.00(Dr)', {x: 447.63751, y: 715.08752});
 const fixture = {...original, text: '100.00(Dr)'};
 const edit = block(fixture, {text: '1000.00(Cr)'});

 const {text} = await exported(original.bytes, fixture, edit);
 assert.ok(text.includes('715.08752'), 'the baseline is the producer\'s own number');
 assert.ok(!/715\.08[0-7]\b/.test(text.replace('715.08752', '')), 'no rounded copy of that baseline');
});

test('a wider value keeps the right edge the producer ended at', async () => {
 const original = await statementPage('100.00(Dr)', {x: 447.63751, y: 400.25});
 const fixture = {...original, text: '100.00(Dr)'};
 const edit = block(fixture, {text: '1000.00(Cr)'});

 const advance = line => [...line].reduce((total, char) => total + (WIDTHS[char] ?? 600), 0) * 0.001 * fixture.size;
 const expected = 447.63751 + advance('100.00(Dr)') - advance('1000.00(Cr)');

 const {text} = await exported(original.bytes, fixture, edit);
 const cell = matrices(text).find(([, , , , , y]) => y === 400.25);
 assert.ok(cell, 'the cell keeps its row');
 assert.ok(Math.abs(cell[4] - expected) < 1e-6, `starts at ${cell[4]}, expected ${expected}`);
 assert.ok(Math.abs(cell[4] + advance('1000.00(Cr)') - (447.63751 + advance('100.00(Dr)'))) < 1e-6, 'the money column still lines up');
});

test('a font the document already has writes the replacement as one plain string', () => {
 // The page's own program is a subset: it has the glyphs for "NEFT", not for
 // every character the page happened to draw. The font dictionary's code map is
 // the whole subset, so the replacement is still a single <hex> Tj.
 const font = {
  codes: new Map([['A', {code: '0041'}], ['B', {code: '0042'}], [' ', {code: '0020'}]]),
  widths: new Map([['0041', 600], ['0042', 700], ['0020', 250]]),
  defaultWidth: 500,
 };
 const encoded = documentHexEncoder(font)('AB A', 10);
 assert.equal(encoded.hex, '004100420020' + '0041');
 assert.equal(encoded.count, 4);
 assert.ok(Math.abs(encoded.width - 21.5) < 1e-9);
});

test('a character the document font cannot map is named, not dropped', () => {
 const font = {codes: new Map([['A', {code: '0041'}]]), widths: new Map(), defaultWidth: 500};
 assert.throws(() => documentHexEncoder(font)('AZ', 10), /no character mapping for "Z"/);
});

test('the export keeps the header marker the document had, not the library\'s', () => {
 // What pdf-lib writes, and what the bank's own PDFBox-written file carries.
 const library = Uint8Array.from([...Buffer.from('%PDF-1.7\n'), 0x25, 0x81, 0x81, 0x81, 0x81, ...Buffer.from('\n28 0 obj\n')]);
 const producer = Uint8Array.from([...Buffer.from('%PDF-1.7\n'), 0x25, 0xe2, 0xe3, 0xcf, 0xd3, ...Buffer.from('\n1 0 obj\n')]);
 const aligned = alignHeader(library, producer);
 assert.equal(Buffer.from(aligned.subarray(0, 14)).toString('latin1'), '%PDF-1.7\n%\xE2\xE3\xCF\xD3');
 assert.ok(!aligned.subarray(0, 32).includes(0x81), 'none of the library marker survives');
 assert.ok(Buffer.from(aligned).toString('latin1').endsWith('\n28 0 obj\n'), 'the body is untouched');
 // A saved PDF addresses its objects by absolute offset: the header must not move.
 assert.equal(aligned.length, library.length, 'alignment never shifts a byte');

 // A document with no marker gets none back — and still no shift.
 const bare = Uint8Array.from([...Buffer.from('%PDF-1.7\n'), ...Buffer.from('1 0 obj\n')]);
 const bareAligned = alignHeader(library, bare);
 assert.equal(Buffer.from(bareAligned.subarray(0, 8)).toString('latin1'), '%PDF-1.7');
 assert.ok(!bareAligned.subarray(0, 24).includes(0x81));
 assert.equal(bareAligned.length, library.length, 'a marker-less original still keeps every offset');
 assert.equal(Buffer.from(bareAligned.subarray(0, 14)).toString('latin1'), '%PDF-1.7\n%    ', 'a plain comment, not a claim');

 // A file that already carries the library's marker is left exactly as it is.
 assert.equal(alignHeader(library, library), library);
});

test('an exported statement starts with the producer\'s header bytes', async () => {
 const original = await statementPage('100.00(Dr)');
 // Pretend the opened file came from the bank: PDFBox's marker, not pdf-lib's.
 const marker = Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
 const head = Buffer.from(original.bytes);
 const at = head.indexOf(Buffer.from([0x25, 0x81, 0x81, 0x81, 0x81]));
 assert.ok(at > 0, 'the fixture is a pdf-lib file');
 head.set(marker, at);
 const bank = new Uint8Array(head);

 const fixture = {...original, text: '100.00(Dr)'};
 const edit = block(fixture, {text: '1000.00(Cr)'});
 const {bytes} = await exported(bank, fixture, edit);
 assert.equal(Buffer.from(bytes.subarray(0, 14)).toString('latin1'), '%PDF-1.7\n%\xE2\xE3\xCF\xD3');
});

test('a protected upload keeps the uploaded file\'s marker, not the decryptor\'s', async () => {
 const original = await statementPage('100.00(Dr)');
 const bankMarker = Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
 // What the user chose: the bank's own bytes, marker included.
 const bank = Uint8Array.from(original.bytes);
 bank.set(bankMarker, bank.indexOf(0x25, 9));
 // What the editor works on after a qpdf decryption: qpdf's own marker.
 const working = Uint8Array.from(original.bytes);
 working.set([0x25, 0xbf, 0xf7, 0xa2, 0xfe], working.indexOf(0x25, 9));

 const fixture = {...original, text: '100.00(Dr)'};
 const edit = block(fixture, {text: '1000.00(Cr)'});
 const bytes = await exportNativePdf({
  original: working, headerSource: bank, edits: new Map([[edit.id, edit]]),
  getPage: pageData(fixture, [block(fixture)]), PDFLib: L,
 });
 assert.equal(Buffer.from(bytes.subarray(0, 14)).toString('latin1'), '%PDF-1.7\n%\xE2\xE3\xCF\xD3');
 assert.ok(!bytes.subarray(0, 64).includes(0x81), 'no library marker');
 assert.ok(!bytes.subarray(0, 64).includes(0xbf), 'no decryptor marker');
 const text = latin1(bytes);
 const xref = Number(/startxref\s+(\d+)/.exec(text)[1]);
 assert.match(text.slice(xref, xref + 20), /^(xref|\d+ 0 obj)/, 'the cross-reference still points at the objects');
});

// A page whose cells are painted by a form XObject: the producer writes its text
// in the form's own units, and the page scales that form down. This is the shape
// a bank statement export has, and the shape an edit has to survive.
const FORM_CTM = [0.5, 0, 0, 0.5, 100, 200];
const FORM_ORIGIN = [40, 50];
const FORM_TEXT = 'Cell 1';
const formPageX = FORM_CTM[0] * FORM_ORIGIN[0] + FORM_CTM[4];
const formPageY = FORM_CTM[3] * FORM_ORIGIN[1] + FORM_CTM[5];

async function formPage() {
 const pdf = await L.PDFDocument.create();
 const font = await pdf.embedFont(L.StandardFonts.Helvetica);
 const page = pdf.addPage([595, 842]);
 const hex = font.encodeText(FORM_TEXT).asString();
 const form = pdf.context.flateStream(
  `BT /F1 20 Tf 1 0 0 1 ${FORM_ORIGIN[0]} ${FORM_ORIGIN[1]} Tm <${hex}> Tj ET`,
  {Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 400], Resources: {Font: {F1: font.ref}}},
 );
 const formRef = pdf.context.register(form);
 const resources = pdf.context.obj({Font: {F1: font.ref}, XObject: {Fm1: formRef}});
 page.node.set(name('Resources'), resources);
 page.node.set(name('Contents'), pdf.context.register(
  pdf.context.flateStream(`q ${FORM_CTM.join(' ')} cm /Fm1 Do Q`),
 ));
 return {bytes: await pdf.save(), font};
}

function formBlock(font, overrides = {}) {
 return {
  id: '1:0', page: 1, text: FORM_TEXT, x: formPageX, y: 842 - formPageY, size: 20 * 0.5,
  width: font.widthOfTextAtSize(FORM_TEXT, 20) * 0.5, height: 10, fontName: 'Helvetica',
  fontId: 'g_d0_f1', font: 'original', bold: false, italic: false, underline: false,
  spacing: 0, wordSpacing: 0, lineheight: 1.2, align: 'left', scaleX: 1, textMode: 0,
  strokeWidth: 1, color: '#000000', strokeColor: '#000000', ops: [0], canEdit: true, ...overrides,
 };
}

function formOps(font) {
 const glyphs = [...FORM_TEXT].map(char => ({
  originalCharCode: char.charCodeAt(0), unicode: char,
  width: (font.widthOfTextAtSize(char, 20) / 20) * 1000, isSpace: char === ' ',
 }));
 return {index: 0, str: FORM_TEXT, fontId: 'g_d0_f1', font: {fontMatrix: [0.001, 0, 0, 0.001, 0, 0]},
  fontSize: 20, color: '#000000', strokeColor: '#000000', mode: 0, lineWidth: 1, charSpacing: 0,
  wordSpacing: 0, textRise: 0, hScale: 100, pattern: false, strokePattern: false, glyphs};
}

function formData(font, blocks) {
 return async () => ({
  vp: {transform: [1, 0, 0, -1, 0, 842]},
  info: {ops: [formOps(font)]},
  blocks,
 });
}

// The page position a Tm inside the form puts its text at, and the size it is
// actually shown at, both measured the way a viewer reads the page.
function paintedInForm(content, formMatrix = [1, 0, 0, 1, 0, 0]) {
 const match = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/.exec(content);
 assert.ok(match, 'the replacement states where it goes');
 const [a, b, c, d, e, f] = match.slice(1, 7).map(Number);
 const x = FORM_CTM[0] * (formMatrix[0] * e + formMatrix[2] * f + formMatrix[4]) + FORM_CTM[4];
 const y = FORM_CTM[3] * (formMatrix[1] * e + formMatrix[3] * f + formMatrix[5]) + FORM_CTM[5];
 const size = Number(/([-\d.]+) Tf/.exec(content)?.[1] ?? NaN) * FORM_CTM[0] * a;
 return {x, y, size};
}

test('a moved block is written at the coordinates the user set', async () => {
 const original = await statementPage('100.00(Dr)');
 const fixture = {...original, text: '100.00(Dr)'};
 const moved = block(fixture, {x: fixture.x + 40, y: viewY(fixture.y) - 15});
 const {text} = await exported(original.bytes, fixture, moved);
 const cell = matrices(text).find(matrix => Math.abs(matrix[5] - (fixture.y + 15)) < 0.01);
 assert.ok(cell, 'the replacement is placed on its own baseline');
 assert.deepEqual([cell[0], cell[1], cell[2], cell[3]], [1, 0, 0, 1], 'no squeeze and no flip');
 assert.ok(Math.abs(cell[4] - (fixture.x + 40)) < 0.01, `expected x ${fixture.x + 40}, found ${cell[4]}`);
});

test('a cell typed as zero is still drawn, with the cell\'s own placement', async () => {
 const original = await statementPage('0.00');
 const fixture = {...original, text: '0.00'};
 const typed = block(fixture, {text: '0.00'});
 const {text} = await exported(original.bytes, fixture, typed);
 assert.match(text, /Tj|TJ/, 'the zero is shown, not dropped');
 const cell = matrices(text).find(matrix => Math.abs(matrix[5] - fixture.y) < 0.01);
 assert.ok(Math.abs(cell[4] - fixture.x) < 0.01, 'the value keeps the cell it belongs to');
});

test('a run inside a scaled form keeps the size and position the page showed', async () => {
 const {bytes, font} = await formPage();
 const fixture = formBlock(font);
 const edit = {...fixture, text: 'Cell 11'};
 const out = await exportNativePdf({
  original: bytes, edits: new Map([[fixture.id, edit]]), getPage: formData(font, [fixture]), PDFLib: L,
 });
 const pdf = await L.PDFDocument.load(out.slice(), {updateMetadata: false});
 const page = pdf.getPage(0);
 // The form is rewritten into a new XObject; the page keeps pointing at one.
 const xobjects = pdf.context.lookup(page.node.Resources().get(name('XObject')), L.PDFDict);
 const forms = [...xobjects.entries()]
  .map(([key, ref]) => [key, pdf.context.lookup(ref)])
  .filter(([, value]) => value?.dict?.get(name('Subtype'))?.toString() === '/Form');
 assert.ok(forms.length >= 1);
 const shown = forms.map(([, form]) => latin1(L.decodePDFRawStream(form).decode())).find(content => /43656C6C203131/.test(content));
 assert.ok(shown, 'the replacement lives inside the form it came from');
 const painted = paintedInForm(shown);
 assert.ok(Math.abs(painted.x - fixture.x) < 0.01, `same x: ${painted.x} vs ${fixture.x}`);
 assert.ok(Math.abs(painted.y - (842 - fixture.y)) < 0.01, 'same baseline');
 assert.ok(Math.abs(painted.size - fixture.size) < 0.01, `the same size on the page: ${painted.size} vs ${fixture.size}`);
});

test('a block moved out of its form is drawn on the page, so the form cannot clip it', async () => {
 const {bytes, font} = await formPage();
 const fixture = formBlock(font);
 const moved = {...fixture, x: fixture.x + 60, y: fixture.y - 25};
 const out = await exportNativePdf({
  original: bytes, edits: new Map([[fixture.id, moved]]), getPage: formData(font, [fixture]), PDFLib: L,
 });
 const pdf = await L.PDFDocument.load(out.slice(), {updateMetadata: false});
 const page = pdf.getPage(0);
 const pageText = latin1(L.decodePDFRawStream(pdf.context.lookup(page.node.get(name('Contents')))).decode());
 const drawn = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm[\s\S]*?Tj/.exec(pageText);
 assert.ok(drawn, 'the moved run is in the page stream, outside the form');
 const [a, , , d, e, f] = drawn.slice(1, 7).map(Number);
 assert.deepEqual([a, d], [1, 1], 'the run keeps the page\'s own units: no form matrix leaks out');
 assert.ok(Math.abs(e - moved.x) < 0.01, `x ${e} vs ${moved.x}`);
 assert.ok(Math.abs(f - (842 - moved.y)) < 0.01, `baseline ${f} vs ${842 - moved.y}`);
});

test('a value drawn beside its old run keeps the producer baseline to the last decimal', async () => {
 // The producer wrote 61.26251, which the preview only ever holds as 138.737 in its
 // own top-down coordinates. A replacement drawn as its own run from the rounded
 // number puts 61.262 back on the same row, which is the trace of another program
 // typing into the page.
 const original = await statementPage('100.00(Dr)', {x: 447.63751, y: 61.26251});
 const fixture = {...original, text: '100.00(Dr)'};
 const placement = {y: Math.round(viewY(fixture.y) * 1000) / 1000, yExact: viewY(fixture.y)};
 const edit = block(fixture, {text: '1000.00(Cr)', font: 'Helvetica', ...placement});

 const {text} = await exported(original.bytes, fixture, edit, [block(fixture, placement)]);
 const row = matrices(text).filter(([, , , , , y]) => Math.abs(y - 61.26251) < 0.05);
 assert.ok(row.length >= 2, 'the replacement is on the row it belongs to');
 for (const [, , , , , y] of row) assert.ok(Math.abs(y - 61.26251) < 1e-9, `the row keeps its baseline, not ${y}`);
});

test('a value that sits off its column ends on the column the page uses', async () => {
 const pdf = await L.PDFDocument.create();
 const font = await pdf.embedFont(L.StandardFonts.Helvetica);
 const page = pdf.addPage([300, 200]);
 const width = value => font.widthOfTextAtSize(value, 9);
 const column = 60 + width('2000.00(Dr)');
 // The producer writes five decimals on this row; the editor only holds three.
 const rowY = 40.23751;
 // Two cells hold the same value: one ends on the column, one sits 23 pt left of it.
 const cellsText = [
  ['2000.00(Dr)', 60], ['300.00(Dr)', column - width('300.00(Dr)')],
  ['120.00(Dr)', column - width('120.00(Dr)')],
  ['500.00(Cr)', 40], ['500.00(Cr)', column - width('500.00(Cr)')],
 ];
 for (const [value, x] of cellsText) page.drawText(value, {x, y: rowY, size: 9, font});
 page.drawText(ALPHABET, {x: 20, y: 150, size: 9, font});
 const bytes = await pdf.save();
 const placement = {y: Math.round(viewY(rowY) * 1000) / 1000, yExact: viewY(rowY)};
 // The page's own glyph advances, so the exporter measures what the page shows.
 const metricOp = (index, text) => ({...op(index, text),
  glyphs: [...text].map(char => ({originalCharCode: char.codePointAt(0), unicode: char,
   width: font.widthOfTextAtSize(char, 9) / 9 * 1000, isSpace: char === ' '}))});
 const cells = cellsText.map(([text, x], index) => block(
  {text, x, y: rowY, size: 9, width: width(text)},
  {id: `1:${index}`, ops: [index], xExact: x, widthExact: width(text), ...placement},
 ));
 // Both cells are retyped to the same value. The one that was already aligned is
 // the reference: the one that had drifted has to land on the same x.
 const replace = async index => {
  const out = await exportNativePdf({
   original: bytes, edits: new Map([[cells[index].id, {...cells[index], text: '50000.00(Cr)'}]]),
   getPage: async () => ({vp: {transform: [1, 0, 0, -1, 0, 200]},
    info: {ops: [...cellsText.map(([text], i) => metricOp(i, text)), metricOp(cellsText.length, ALPHABET)]},
    blocks: cells}), PDFLib: L,
  });
  const pdfOut = await L.PDFDocument.load(out.slice(), {updateMetadata: false});
  const text = latin1(L.decodePDFRawStream(pdfOut.context.lookup(pdfOut.getPage(0).node.get(name('Contents')))).decode());
  const row = matrices(text).filter(matrix => Math.abs(matrix[5] - rowY) < 0.01);
  const drawn = row.map(matrix => matrix[4]).filter(x => !cellsText.some(([, own]) => Math.abs(own - x) < 1e-6));
  return {drawn, row};
 };
 const drifted = await replace(3);
 const aligned = await replace(4);
 assert.equal(drifted.drawn.length, 1, 'the retyped value is drawn once');
 assert.equal(aligned.drawn.length, 1, 'the aligned value is drawn once');
 assert.ok(Math.abs(drifted.drawn[0] - aligned.drawn[0]) < 1e-6,
  `the value ends on its column: ${drifted.drawn[0]} vs ${aligned.drawn[0]}`);
 for (const matrix of drifted.row) assert.ok(Math.abs(matrix[5] - rowY) < 1e-9, `the row keeps its own baseline, not ${matrix[5]}`);
});

test('a cell whose run was truncated keeps its column when the full value is typed', async () => {
 // The producer split a cell across runs, so the run that carries it is not an
 // amount string on its own. The value the user typed is one, and it has to end on
 // the money column its neighbours end on instead of at the old run's left edge.
 const pdf = await L.PDFDocument.create();
 const font = await pdf.embedFont(L.StandardFonts.Helvetica);
 const page = pdf.addPage([300, 200]);
 const width = value => font.widthOfTextAtSize(value, 9);
 const column = 60 + width('2000.00(Dr)');
 const rowY = 40.23751;
 const cellsText = [
  ['2000.00(Dr)', 60], ['300.00(Dr)', column - width('300.00(Dr)')],
  ['120.00(Dr)', column - width('120.00(Dr)')],
  ['3000.00(Cr', column - 28 - width('3000.00(Cr')],
 ];
 for (const [value, x] of cellsText) page.drawText(value, {x, y: rowY, size: 9, font});
 page.drawText(ALPHABET, {x: 20, y: 150, size: 9, font});
 const bytes = await pdf.save();
 const placement = {y: Math.round(viewY(rowY) * 1000) / 1000, yExact: viewY(rowY)};
 const metricOp = (index, text) => ({...op(index, text),
  glyphs: [...text].map(char => ({originalCharCode: char.codePointAt(0), unicode: char,
   width: font.widthOfTextAtSize(char, 9) / 9 * 1000, isSpace: char === ' '}))});
 const cells = cellsText.map(([text, x], index) => block(
  {text, x, y: rowY, size: 9, width: width(text)},
  {id: `1:${index}`, ops: [index], xExact: x, widthExact: width(text), ...placement},
 ));
 const out = await exportNativePdf({
  original: bytes, edits: new Map([[cells[3].id, {...cells[3], text: '13000.00(Cr)'}]]),
  getPage: async () => ({vp: {transform: [1, 0, 0, -1, 0, 200]},
   info: {ops: [...cellsText.map(([text], i) => metricOp(i, text)), metricOp(cellsText.length, ALPHABET)]},
   blocks: cells}), PDFLib: L,
 });
 const pdfOut = await L.PDFDocument.load(out.slice(), {updateMetadata: false});
 const text = latin1(L.decodePDFRawStream(pdfOut.context.lookup(pdfOut.getPage(0).node.get(name('Contents')))).decode());
 const expected = column - width('13000.00(Cr)');
 const drawn = matrices(text).filter(matrix => Math.abs(matrix[5] - rowY) < 0.01)
  .map(matrix => matrix[4]).filter(x => Math.abs(x - expected) < 1e-6);
 assert.equal(drawn.length, 1, `the value is placed to end on ${column}, at ${expected}`);
});

test('a truncated run that ends on the column still anchors the retyped value', async () => {
 // The producer ended the run on the column even though the run holds only part of
 // the amount, so there is no drift to correct: the column edge is already met. The
 // new value still has to end there, not at the old run's left edge.
 const pdf = await L.PDFDocument.create();
 const font = await pdf.embedFont(L.StandardFonts.Helvetica);
 const page = pdf.addPage([300, 200]);
 const width = value => font.widthOfTextAtSize(value, 9);
 const column = 60 + width('2000.00(Dr)');
 const rowY = 40.23751;
 const cellsText = [
  ['2000.00(Dr)', 60], ['300.00(Dr)', column - width('300.00(Dr)')],
  ['120.00(Dr)', column - width('120.00(Dr)')],
  ['3000.00(Cr', column - width('3000.00(Cr')],
 ];
 for (const [value, x] of cellsText) page.drawText(value, {x, y: rowY, size: 9, font});
 page.drawText(ALPHABET, {x: 20, y: 150, size: 9, font});
 const bytes = await pdf.save();
 const placement = {y: Math.round(viewY(rowY) * 1000) / 1000, yExact: viewY(rowY)};
 const metricOp = (index, text) => ({...op(index, text),
  glyphs: [...text].map(char => ({originalCharCode: char.codePointAt(0), unicode: char,
   width: font.widthOfTextAtSize(char, 9) / 9 * 1000, isSpace: char === ' '}))});
 const cells = cellsText.map(([text, x], index) => block(
  {text, x, y: rowY, size: 9, width: width(text)},
  {id: `1:${index}`, ops: [index], xExact: x, widthExact: width(text), ...placement},
 ));
 const out = await exportNativePdf({
  original: bytes, edits: new Map([[cells[3].id, {...cells[3], text: '13000.00(Cr)'}]]),
  getPage: async () => ({vp: {transform: [1, 0, 0, -1, 0, 200]},
   info: {ops: [...cellsText.map(([text], i) => metricOp(i, text)), metricOp(cellsText.length, ALPHABET)]},
   blocks: cells}), PDFLib: L,
 });
 const pdfOut = await L.PDFDocument.load(out.slice(), {updateMetadata: false});
 const text = latin1(L.decodePDFRawStream(pdfOut.context.lookup(pdfOut.getPage(0).node.get(name('Contents')))).decode());
 const expected = column - width('13000.00(Cr)');
 const drawn = matrices(text).filter(matrix => Math.abs(matrix[5] - rowY) < 0.01)
  .map(matrix => matrix[4]).filter(x => Math.abs(x - expected) < 1e-6);
 assert.equal(drawn.length, 1, `the value is placed to end on ${column}, at ${expected}`);
});
