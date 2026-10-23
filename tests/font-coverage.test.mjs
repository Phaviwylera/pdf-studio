import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {describeMissing, glyphMapEncode, lineFontRuns, missingOriginalGlyphs, originalFontCoverage, parsedHasGlyph} from '../dist/font-coverage.mjs';
import {exportNativePdf, originalMissingChars} from '../dist/native-export.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
const fontkit = require('../dist/vendor/fontkit.umd.min.js');
const liberation = new Uint8Array(await readFile(new URL('../dist/vendor/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));
const embedded = fontkit.create(liberation);

// The page observed lowercase glyphs only; the embedded font also carries
// capitals and digits that were used elsewhere in the document.
const pageGlyphs = new Map([['h', '\uE010'], ['e', '\uE011'], ['l', '\uE012'], ['o', '\uE013']]);
const limited = {hasGlyphForCodePoint: codePoint => 'helo'.includes(String.fromCodePoint(codePoint))};

test('embedded font coverage includes glyphs used on other pages', () => {
 assert.deepEqual(missingOriginalGlyphs({glyphMap: pageGlyphs, parsed: embedded}, 'hello'), []);
 assert.deepEqual(missingOriginalGlyphs({glyphMap: pageGlyphs, parsed: embedded}, 'HELLO 123'), []);
 const coverage = originalFontCoverage({glyphMap: pageGlyphs, parsed: embedded}, 'HELLO 123');
 assert.equal(coverage.ok, true);
 assert.equal(glyphMapEncode(pageGlyphs, 'HELLO 123'), null, 'the current page map alone cannot encode capitals');
});

test('characters absent from the embedded subset are reported precisely', () => {
 const block = {glyphMap: pageGlyphs, parsed: limited};
 assert.deepEqual(missingOriginalGlyphs(block, 'HELLO 123'), ['H', 'E', 'L', 'O', '1', '2', '3']);
 assert.equal(originalFontCoverage(block, 'HELLO 123').ok, false);
 assert.equal(glyphMapEncode(pageGlyphs, 'hello'), '\uE010\uE011\uE012\uE012\uE013');
 assert.equal(glyphMapEncode(pageGlyphs, 'hi'), null);
});

test('missing character descriptions are deduplicated and bounded', () => {
 assert.equal(describeMissing(['H', 'E', 'H', '5']), 'H E 5');
 assert.equal(describeMissing(Array.from('ABCDEFGHIJKL'), 4), 'A B C D and 8 more');
 assert.equal(describeMissing(['\u00A0']), 'U+00A0');
});

test('parser coverage is defensive about unavailable glyph tables', () => {
 assert.equal(parsedHasGlyph(embedded, 'A'), true);
 assert.equal(parsedHasGlyph(embedded, '\u{10FFFD}'), false);
 assert.equal(parsedHasGlyph(null, 'A'), false);
 assert.equal(parsedHasGlyph({}, 'A'), false);
});

test('line runs keep supported characters in the original font and mix fallbacks', () => {
 const options = {fallbackCss: '12px "Arial", sans-serif', programCss: '12px "PdfFont1", sans-serif', privateCss: '12px "g_d0_f1", sans-serif'};
 assert.deepEqual(lineFontRuns({glyphMap: pageGlyphs, parsed: limited}, 'heX', options).map(run => [run.text, run.css]), [
  ['he', '12px "PdfFont1", sans-serif'],
  ['X', '12px "Arial", sans-serif'],
 ]);
 assert.deepEqual(lineFontRuns({glyphMap: pageGlyphs, parsed: null}, 'hello', options).map(run => [run.text, run.css]), [
  ['\uE010\uE011\uE012\uE012\uE013', '12px "g_d0_f1", sans-serif'],
 ]);
});

test('export detects characters the page text encoding does not cover', () => {
 const map = new Map([['h', {bytes: Uint8Array.of(104), unitWidth: 0.6}], ['e', {bytes: Uint8Array.of(101), unitWidth: 0.6}]]);
 assert.deepEqual(originalMissingChars(map, 'he'), []);
 assert.deepEqual(originalMissingChars(map, 'HELLO 123'), ['H', 'E', 'L', 'O', ' ', '1', '2', '3']);
});

async function encodedPageFixture() {
 const pdf = await L.PDFDocument.create();
 const font = await pdf.embedFont(L.StandardFonts.Helvetica);
 pdf.addPage([300, 200]).drawText('hello', {x: 30, y: 150, size: 12, font});
 return pdf.save();
}

function originalBlock(text) {
 return {
  id: '1:0', page: 1, text, x: 30, y: 150, size: 12, width: 60, height: 12, angle: 0,
  fontName: 'Helvetica', fontId: 'g_d0_f1', font: 'original', fallback: 'Arial',
  bold: false, italic: false, underline: false, spacing: 0, lineheight: 1.2,
  align: 'left', scaleX: 1, ops: [0], canEdit: true, color: '#000000',
 };
}

const getPage = async () => ({
 vp: {transform: [1, 0, 0, -1, 0, 200]},
 info: {
  ops: [{
   index: 0, str: 'hello', fontId: 'g_d0_f1', font: {fontMatrix: [0.001, 0, 0, 0.001, 0, 0]},
   color: '#000000', mode: 0, pattern: false,
   glyphs: [...'hello'].map(char => ({originalCharCode: char.codePointAt(0), unicode: char, width: 600, isSpace: false})),
  }],
 },
});

test('native export embeds the source font for characters outside the page encoding', async () => {
 const original = await encodedPageFixture();
 const block = originalBlock('HELLO 123');
 const exported = await exportNativePdf({
  original, edits: new Map([[block.id, block]]), getPage, PDFLib: L,
  originalFonts: new Map([['g_d0_f1', {data: liberation, parsed: embedded}]]), fontkit,
 });
 const output = await L.PDFDocument.load(exported, {updateMetadata: false});
 let fontFile2 = 0;
 for (const [, object] of output.context.enumerateIndirectObjects()) {
  if (object instanceof L.PDFDict && object.get(L.PDFName.of('FontFile2'))) fontFile2++;
 }
 assert.equal(fontFile2, 1, 'the original embedded font is reused instead of dropping unsupported letters');
 const content = await pageContent(output);
 assert.match(content, /\/F\d+ 12 Tf/);
 assert.match(content, /\[<[0-9A-F]+> -\d+(?:\.\d+)? <[0-9A-F]+>\] TJ/, 'the word gap is drawn without a notdef space glyph');
 assert.doesNotMatch(content, /hello/);
});

test('native export refuses to drop characters when no font program is available', async () => {
 const original = await encodedPageFixture();
 const block = originalBlock('HELLO 123');
 await assert.rejects(
  () => exportNativePdf({original, edits: new Map([[block.id, block]]), getPage, PDFLib: L}),
  /original font cannot encode "H"/,
 );
});

async function pageContent(pdf) {
 const page = pdf.getPage(0);
 const object = pdf.context.lookup(page.node.get(L.PDFName.of('Contents')));
 return new TextDecoder('latin1').decode(L.decodePDFRawStream(object).decode());
}

test('editor registers each embedded program and hands it to native export', async () => {
 const app = await readFile(new URL('../dist/app.mjs', import.meta.url), 'utf8');
 assert.match(app, /async function ensureOriginalFont\(id,font,page=null\)/);
 assert.match(app, /async function registerFontProgram\(data\)/);
 assert.match(app, /new FontFace\(family,data\.buffer\.slice\(data\.byteOffset,data\.byteOffset\+data\.byteLength\)\)/);
 assert.match(app, /await ensureOriginalFont\(id,font,n\)/);
 assert.match(app, /exportNativePdf\(\{original,edits,getPage,fonts:loadedFonts,originalFonts,/);
 assert.match(app, /originalFonts\.clear\(\)/);
 const exporter = await readFile(new URL('../dist/native-export.mjs', import.meta.url), 'utf8');
 assert.match(exporter, /originalFonts=new Map\(\)/);
 assert.match(exporter, /mayEmbedTypeface\(candidates,record\.name\)/, 'a typeface the file already contains is never embedded twice');
 assert.match(exporter, /encodesAll\(entry\.font,block\.text\)/, 'an existing font that covers the text is reused');
 assert.match(exporter, /The original font cannot encode/, 'a missing character is reported instead of duplicating the font');
});
