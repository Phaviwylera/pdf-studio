import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {
 MEASURE_DECIMALS, baselineOffsetFor, canvasStrokeWidth, formatMeasure, glyphLayout,
 normalizeMeasure, paintStateUsable, sameTextState, textPaintMode,
} from '../dist/typography.mjs';
import {exportNativePdf} from '../dist/native-export.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const decoder = new TextDecoder('latin1');

test('measures are normalized to 0.001 pt so float noise never reaches the UI or export', () => {
 assert.equal(MEASURE_DECIMALS, 3);
 assert.equal(normalizeMeasure(12.000000000000002), 12);
 assert.equal(normalizeMeasure(11.999999999999998), 12);
 assert.equal(normalizeMeasure(9.9964), 9.996);
 assert.equal(normalizeMeasure(-0), 0);
 assert.equal(normalizeMeasure(Number.NaN), 0);
 assert.equal(formatMeasure(12.0000000001), '12');
 assert.equal(formatMeasure(0.1 + 0.2), '0.3');
 assert.equal(formatMeasure(undefined), '0');
});

test('glyph layout uses PDF advances: no kerning, character spacing between glyphs, word spacing on spaces', () => {
 const widths = {A: 10, V: 8, ' ': 4};
 const measured = [];
 const measure = char => { measured.push(char); return widths[char] ?? 0; };
 const tight = glyphLayout({text: 'AV', spacing: 0, wordSpacing: 0, measure});
 assert.deepEqual(tight.glyphs.map(g => [g.char, g.offset]), [['A', 0], ['V', 10]]);
 assert.equal(tight.width, 18);
 const tracked = glyphLayout({text: 'A V', spacing: 2, wordSpacing: 3, measure});
 assert.deepEqual(tracked.glyphs.map(g => [g.char, g.offset]), [['A', 0], [' ', 12], ['V', 21]]);
 assert.equal(tracked.width, 29);
 assert.deepEqual(measured, ['A', 'V', 'A', ' ', 'V'], 'each glyph is measured on its own: no pair kerning or ligatures');
});

test('text paint modes and stroke weights follow the PDF text state', () => {
 assert.deepEqual(textPaintMode(0), {fill: true, stroke: false});
 assert.deepEqual(textPaintMode(1), {fill: false, stroke: true});
 assert.deepEqual(textPaintMode(2), {fill: true, stroke: true});
 assert.equal(textPaintMode(3), null);
 assert.equal(canvasStrokeWidth(1.5, 2, 1), 0.75, 'horizontal text scaling is compensated');
 assert.equal(canvasStrokeWidth(0, 1, 2), 0.5, 'a zero PDF line width is a one-pixel hairline');
 assert.equal(canvasStrokeWidth(0, 2, 2), 0.25);
});

test('baseline offset matches a CSS line box instead of a fixed 0.85 em guess', () => {
 const ctx = {measureText: () => ({fontBoundingBoxAscent: 9, fontBoundingBoxDescent: 3})};
 assert.equal(baselineOffsetFor(ctx, {fontSize: 12, lineHeight: 1.2}), 10.2);
 const fallback = {measureText: () => ({})};
 assert.equal(baselineOffsetFor(fallback, {fontSize: 10, lineHeight: 1}), 8, 'fallback metrics place the baseline at 0.8 em');
});

test('a block is editable only when every text operation shares one paint state', () => {
 const base = {mode: 0, fontSize: 12, lineWidth: 1, charSpacing: 0, wordSpacing: 0, textRise: 0, hScale: 100, strokeColor: '#000000', fillPattern: false, strokePattern: false};
 assert.equal(sameTextState([base, {...base}]), true);
 assert.equal(sameTextState([base, {...base, lineWidth: 2}]), true, 'stroke weight is irrelevant to fill-only text');
 assert.equal(sameTextState([base, {...base, strokeColor: '#ff0000'}]), true, 'stroke color is irrelevant to fill-only text');
 const stroked = {...base, mode: 2};
 assert.equal(sameTextState([stroked, {...stroked, lineWidth: 2}]), false);
 assert.equal(sameTextState([stroked, {...stroked, strokeColor: '#ff0000'}]), false);
 assert.equal(sameTextState([{...base, fontSize: 12}, {...base, fontSize: 12.0000001}]), true);
 assert.equal(sameTextState([{...base, fontSize: 12}, {...base, fontSize: 13}]), false, 'mixed font sizes are not exported as one style');
 assert.equal(sameTextState([base, {...base, charSpacing: 1}]), false);
 assert.equal(sameTextState([base, {...base, wordSpacing: 1}]), false);
 assert.equal(sameTextState([base, {...base, textRise: 1}]), false);
 assert.equal(sameTextState([base, {...base, mode: 2}]), false);
 assert.equal(sameTextState([base, {...base, mode: 3}]), false);
 assert.equal(sameTextState([base, {...base, fillPattern: true}]), false);
 assert.equal(paintStateUsable({...base, mode: 1, fillPattern: true}), true, 'a fill pattern does not affect stroke-only text');
 assert.equal(paintStateUsable({...base, mode: 1, strokePattern: true}), false);
 assert.equal(paintStateUsable({...base, mode: 2, strokePattern: true}), false);
});

async function sourcePdf() {
 const pdf = await L.PDFDocument.create();
 pdf.addPage([400, 300]);
 return pdf.save();
}

function paintBlock(overrides = {}) {
 return {
  id: '1:new', added: true, page: 1, text: 'A B', x: 250, y: 100, size: 12,
  font: 'Arial', bold: false, italic: false, color: '#000000', spacing: 2, wordSpacing: 3,
  textMode: 2, strokeColor: '#ff0000', strokeWidth: 1.5, lineheight: 1.2, align: 'right',
  scaleX: 1, ops: [], ...overrides,
 };
}

const getPage = async () => ({vp: {transform: [1, 0, 0, -1, 0, 300]}, info: {ops: []}});

async function exportedContent(block) {
 const original = await sourcePdf();
 const bytes = await exportNativePdf({
  original, edits: new Map([[block.id, block]]), getPage, PDFLib: L,
 });
 const pdf = await L.PDFDocument.load(bytes, {updateMetadata: false});
 const page = pdf.getPage(0);
 const raw = pdf.context.lookup(page.node.get(L.PDFName.of('Contents')));
 return decoder.decode(L.decodePDFRawStream(raw).decode());
}

function tmOrigin(content) {
 const match = content.match(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/);
 assert.ok(match, 'the text matrix is present');
 return {x: Number(match[1]), y: Number(match[2])};
}

test('native export writes the same fill/stroke, spacing and weight state the preview uses', async () => {
 const content = await exportedContent(paintBlock());
 assert.match(content, /0 0 0 rg/);
 assert.match(content, /1 0 0 RG/);
 assert.match(content, /1\.5 w/);
 assert.match(content, /2 Tr/);
 assert.match(content, /2 Tc/);
 assert.match(content, /3 Tw/);
 // Default text state (rise 0, horizontal scale 100) is inherited rather than
 // restated, so the export does not carry settings the document never uses.
 assert.doesNotMatch(content, /\bTs\b/);
 assert.doesNotMatch(content, /\bTz\b/);
 assert.doesNotMatch(content, /0 Tr/, 'the original fill+stroke mode is not silently flattened to fill');
 const origin = tmOrigin(content);
 assert.equal(origin.y, 200, 'page height 300 minus the 100 pt baseline');
});

test('word spacing shifts right-aligned text by exactly the same points', async () => {
 const withWordSpacing = tmOrigin(await exportedContent(paintBlock({wordSpacing: 3})));
 const withoutWordSpacing = tmOrigin(await exportedContent(paintBlock({wordSpacing: 0})));
 assert.equal(Math.round((withoutWordSpacing.x - withWordSpacing.x) * 1000) / 1000, 3);
});

test('stroke-only text keeps its stroke mode and weight and is not filled', async () => {
 const content = await exportedContent(paintBlock({textMode: 1, strokeWidth: 2.25, strokeColor: '#00ff00'}));
 assert.match(content, /1 Tr/);
 assert.match(content, /2\.25 w/);
 assert.match(content, /0 1 0 RG/);
 assert.doesNotMatch(content, /2 Tr/);
});

test('typography rules are shared by the editor preview, inline editor and export', async () => {
 const app = await read('../dist/app.mjs');
 const exporter = await read('../dist/native-export.mjs');
 const html = await read('../dist/index.html');
 assert.match(app, /from '\.\/typography\.mjs'/);
 assert.match(app, /setCharSpacing/);
 assert.match(app, /setWordSpacing/);
 assert.match(app, /setTextRise/);
 assert.match(app, /sameTextState\(states\)/);
 assert.match(app, /paintStateUsable/);
 assert.match(app, /function shapeLine\(/);
 assert.match(app, /function naturalWidth\(ctx,b,text\)\{return shapeLine\(ctx,\{\.\.\.b,spacing:0,wordSpacing:0\},text\)\.width\}/);
 assert.match(app, /b\.scaleX=w>0\?b\.width\/w:1/);
 assert.equal((app.match(/naturalWidth\(/g) || []).length, 3, 'one helper plus both scaleX sites use the unspaced advance');
 assert.match(app, /gap=\(\(b\.spacing\|\|0\)\+\(prefix\.endsWith\(' '\)\?\(b\.wordSpacing\|\|0\):0\)\)\*b\.scaleX/);
 assert.match(app, /canvasStrokeWidth\(b\.strokeWidth/);
 assert.match(app, /strokeWidth=Math\.max\(\.01,canvasStrokeWidth\(b\.strokeWidth\?\?1,sx,1\)\*z\)/, 'the inline editor compensates the same horizontal scale as the canvas preview');
 assert.match(app, /fontKerning:'none'/);
 assert.match(app, /fontVariantLigatures:'none'/);
 assert.match(app, /baselineOffsetFor\(ctx,\{fontSize:b\.size,lineHeight:b\.lineheight\}\)/);
 assert.match(app, /transform:sx===1\?'none':`scaleX\(\$\{sx\}\)`/);
 assert.match(app, /textDecorationColor:paint\.fill\?b\.color:\(b\.strokeColor\|\|b\.color\)/);
 assert.match(app, /ctx\.strokeStyle=paint\.fill\?b\.color:\(b\.strokeColor\|\|b\.color\)/);
 assert.match(app, /wordSpacing:\(b\.wordSpacing\|\|0\)\*z\+'px'/);
 assert.match(app, /for\(const id of \['size','spacing','lineheight','x','y'\]\)/);
 assert.match(app, /\$\('wordspacing'\)\.value=formatMeasure\(b\.wordSpacing\)/);
 assert.match(app, /e\.wordSpacing=normalizeMeasure\(rawWordSpacing\)/);
 assert.match(app, /e\.textMode=Number\.isInteger\(b\.textMode\)\?b\.textMode:0/);
 assert.match(app, /e\.strokeWidth=normalizeMeasure\(b\.strokeWidth\?\?1\)/);
 assert.match(app, /e\.textMode===1\)e\.strokeColor=e\.color/);
 assert.match(app, /e\.textMode===2&&e\.color!==b\.color&&String\(b\.strokeColor\|\|''\)\.toLowerCase\(\)===String\(b\.color\|\|''\)\.toLowerCase\(\)\)e\.strokeColor=e\.color/);
 assert.match(app, /if\(paintState\?\.stroke&&!paintState\.fill\)\$\('color'\)\.value/);
 assert.match(exporter, /\$\{spacing\} Tc/);
 assert.match(exporter, /\$\{wordSpacing\} Tw/);
 assert.match(exporter, /\$\{mode\} Tr/);
 assert.match(exporter, /\$\{strokeWidth\} w/);
 assert.match(html, /id="wordspacing" type="number"/);
 assert.match(html, /id="textpaint" class="small"/);
 assert.match(html, /One typography model/);
});
