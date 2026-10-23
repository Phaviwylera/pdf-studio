import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseToUnicode, parseCidWidths, documentFontEncoder} from '../dist/document-font.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');

test('bfchar and bfrange entries both map characters to their codes', () => {
 const cmap = `
 /CIDInit /ProcSet findresource begin
 12 dict begin
 begincmap
 1 begincodespacerange
 <0000><FFFF>
 endcodespacerange
 2 beginbfchar
 <0001> <0048>
 <0002> <0065>
 endbfchar
 2 beginbfrange
 <0003> <0005> <006C>
 <0010> <0012> [<0041> <0042> <0043>]
 endbfrange
 endcmap
 end
 end`;
 const codes = parseToUnicode(cmap);
 assert.deepEqual(codes.get('H'), {code: '0001', width: 2});
 assert.deepEqual(codes.get('e'), {code: '0002', width: 2});
 assert.deepEqual(codes.get('l'), {code: '0003', width: 2});
 assert.deepEqual(codes.get('n'), {code: '0005', width: 2});
 assert.deepEqual(codes.get('A'), {code: '0010', width: 2});
 assert.deepEqual(codes.get('C'), {code: '0012', width: 2});
 assert.equal(codes.size, 8);
});

test('multi-unit and surrogate destinations survive the mapping', () => {
 const cmap = `1 beginbfchar
 <0007> <D83DDE00>
 <0008> <00660069>
 endbfchar`;
 const codes = parseToUnicode(cmap);
 assert.equal(codes.get('😀').code, '0007');
 // A multi-character destination maps every character in it to the same code.
 assert.equal(codes.get('f')?.code, '0008');
 assert.equal(codes.get('i')?.code, '0008');
});

test('a missing or empty CMap yields no mappings instead of throwing', () => {
 assert.equal(parseToUnicode(null).size, 0);
 assert.equal(parseToUnicode('not a cmap').size, 0);
});

test('CID widths are read from both /W array forms', () => {
 const pdf = L.PDFDocument.create.bind(L.PDFDocument);
 // Build the array syntactically; the parser only needs pdf-lib objects.
 return pdf().then(document => {
  const context = document.context;
  const w = context.obj([
   1, [600, 320, 250],
   10, 12, 480,
  ]);
  const descendant = context.obj({Type: 'Font', Subtype: 'CIDFontType2', DW: 1000, W: w});
  const {widths, defaultWidth} = parseCidWidths(descendant, context, L);
  assert.equal(defaultWidth, 1000);
  // Keys match parseToUnicode's lowercase hex, so a width lookup for a code the
  // CMap produced cannot silently miss and fall back to /DW.
  assert.equal(widths.get('0001'), 600);
  assert.equal(widths.get('0002'), 320);
  assert.equal(widths.get('0003'), 250);
  assert.equal(widths.get('000a'), 480);
  assert.equal(widths.get('000c'), 480);
  assert.equal(widths.get('000d'), undefined);
 });
});

test('the encoder writes available codes, word spacing and a real width', () => {
 const font = {
  codes: new Map([['H', {code: '0001'}], ['i', {code: '0002'}], [' ', {code: '0003'}]]),
  widths: new Map([['0001', 700], ['0002', 300], ['0003', 250]]),
  defaultWidth: 1000,
 };
 const encoded = documentFontEncoder(font, {wordSpacing: 2})('Hi i', 10);
 // 2 pt of word spacing is 2000 glyph units, written as a negative TJ offset
 // after the already-advancing space glyph.
 assert.match(encoded.show, /^\[<0001> <0002> <0003> -2000 <0002>\] TJ$/);
 // 700 + 300 + 250 + 300 = 1550/1000 * 10 pt = 15.5 pt
 assert.equal(encoded.width, 15.5);
 assert.equal(encoded.count, 4);

 const spaced = documentFontEncoder(font, {wordSpacing: 0})('Hi i', 10);
 assert.doesNotMatch(spaced.show, /-/, 'without extra word spacing no TJ offset is written');
});

test('characters the font cannot map are named in the error', () => {
 const font = {codes: new Map([['H', {code: '0001'}]]), widths: new Map(), defaultWidth: 1000};
 assert.throws(() => documentFontEncoder(font, {})('Hi', 10), /no character mapping for "i"/);
});
