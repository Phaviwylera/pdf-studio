import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createRequire} from 'node:module';
import {exportNativePdf} from '../dist/native-export.mjs';
import {
 splitFontName, fontKey, fontLabel, buildDocumentFontInventory, pageFontList, pageOneFonts,
 reusableProgram, reuseTable, formatFontInventory, summarizeFontInventory, readFontResource,
} from '../dist/font-inventory.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
const fontkit = require('../dist/vendor/fontkit.umd.min.js');
const ttf = new Uint8Array(await readFile(new URL('../dist/vendor/standard_fonts/LiberationSans-Regular.ttf', import.meta.url)));
const ttfBold = new Uint8Array(await readFile(new URL('../dist/vendor/standard_fonts/LiberationSans-Bold.ttf', import.meta.url)));

test('subset tags and style suffixes are split from the typeface identity', () => {
 const regular = splitFontName('ABCDEF+Arial-BoldMT');
 assert.equal(regular.subset, 'ABCDEF');
 assert.equal(regular.baseFont, 'Arial-BoldMT');
 assert.equal(regular.bold, true);
 assert.equal(regular.italic, false);
 assert.equal(regular.family, 'arial');

 const italic = splitFontName('TimesNewRomanPS-ItalicMT');
 assert.equal(italic.italic, true);
 assert.equal(italic.bold, false);
 assert.equal(italic.family, 'timesnewromanps');

 const plain = splitFontName('Helvetica');
 assert.equal(plain.subset, null);
 assert.equal(plain.family, 'helvetica');
});

test('the same face embedded as different subsets shares one key', () => {
 assert.equal(fontKey('ABCDEF+OpenSans-Bold'), fontKey('GHIJKL+OpenSans-Bold'));
 assert.notEqual(fontKey('ABCDEF+OpenSans-Bold'), fontKey('ABCDEF+OpenSans'));
 assert.notEqual(fontKey('ABCDEF+OpenSans-Italic'), fontKey('ABCDEF+OpenSans'));
 assert.equal(fontLabel({family: 'opensans', bold: true, italic: false}), 'opensans Bold');
});

async function newDocument() {
 const pdf = await L.PDFDocument.create();
 pdf.registerFontkit(fontkit);
 return pdf;
}

async function multiPage({embedded = true} = {}) {
 const pdf = await newDocument();
 const font = embedded ? await pdf.embedFont(ttf, {subset: true}) : await pdf.embedFont(L.StandardFonts.Helvetica);
 for (let i = 0; i < 3; i++) pdf.addPage([200, 200]).drawText('Sample text', {x: 20, y: 150, size: 12, font});
 return pdf.save({useObjectStreams: true, addDefaultPage: false});
}

test('an embedded font used on later pages is inventoried with page 1 as its donor', async () => {
 const inventory = await buildDocumentFontInventory(await multiPage(), L);
 assert.equal(inventory.pageCount, 3);
 const entry = inventory.fonts.find(font => font.embedded);
 assert.ok(entry, 'the embedded font is reported');
 assert.deepEqual(entry.pages, [1, 2, 3]);
 assert.equal(entry.programPage, 1);
 assert.ok(entry.program instanceof Uint8Array && entry.program.length > 100);
 assert.match(entry.baseFont, /LiberationSans/);
 assert.ok(entry.subtypes.includes('Type0'), 'TTF fonts are Type0 with a descendant descriptor');

 const reuse = reuseTable(inventory).find(row => row.embedded);
 assert.equal(reuse.donorPage, 1);
 assert.deepEqual(reuse.reusedOn, [2, 3]);
 assert.deepEqual(pageOneFonts(inventory).map(font => font.key), [reuse.key]);
 assert.equal(pageFontList(inventory, 3).length, 1);
});

test('a non-embedded standard font is reported and never used as a donor', async () => {
 const inventory = await buildDocumentFontInventory(await multiPage({embedded: false}), L);
 const entry = inventory.fonts[0];
 assert.equal(entry.embedded, false);
 assert.equal(entry.programPage, null);
 const row = reuseTable(inventory)[0];
 assert.deepEqual(row.unusableOn, [1, 2, 3]);
 assert.deepEqual(row.reusedOn, []);
 assert.equal(reusableProgram(inventory, {key: entry.key}), null);
 assert.match(formatFontInventory(inventory), /not embedded anywhere/);
});

test('reusableProgram names the donor page and marks cross-page reuse', async () => {
 const inventory = await buildDocumentFontInventory(await multiPage(), L);
 const key = inventory.fonts[0].key;
 const fromPage1 = reusableProgram(inventory, {key, page: 1});
 assert.equal(fromPage1.programPage, 1);
 assert.equal(fromPage1.reused, false);
 const fromPage3 = reusableProgram(inventory, {key, page: 3});
 assert.equal(fromPage3.programPage, 1);
 assert.equal(fromPage3.reused, true);
 assert.ok(fromPage3.program.length > 100);
});

test('bold and regular programs stay separate entries', async () => {
 const pdf = await newDocument();
 const regular = await pdf.embedFont(ttf, {subset: true});
 const bold = await pdf.embedFont(ttfBold, {subset: true});
 pdf.addPage([200, 200]).drawText('Regular', {x: 20, y: 150, size: 12, font: regular});
 pdf.addPage([200, 200]).drawText('Bold', {x: 20, y: 150, size: 12, font: bold});
 const inventory = await buildDocumentFontInventory(await pdf.save(), L);
 const rows = reuseTable(inventory);
 assert.equal(rows.length, 2);
 const boldRow = rows.find(row => row.bold);
 assert.ok(boldRow, 'bold face detected');
 assert.deepEqual(boldRow.pages, [2]);
 assert.deepEqual(rows.find(row => !row.bold).pages, [1]);
});

test('a handcrafted inventory reuses page 1 for pages without their own program', () => {
 const key = fontKey('ABCDEF+OpenSans');
 const inventory = {
  pageCount: 4,
  pages: [
   {page: 1, fonts: [{page: 1, key, baseFont: 'ABCDEF+OpenSans', subtype: 'Type0', embedded: true}]},
   {page: 4, fonts: [{page: 4, key, baseFont: 'ABCDEF+OpenSans', subtype: 'Type0', embedded: false}]},
  ],
  fonts: [{
   key, family: 'opensans', baseFont: 'ABCDEF+OpenSans', baseFonts: ['ABCDEF+OpenSans'], bold: false, italic: false,
   subtypes: ['Type0'], embedded: true, program: new Uint8Array([0, 1, 2, 3]), programPage: 1, programKey: 'FontFile2',
   pages: [1, 4], resourceNames: ['F1'],
  }],
 };
 const row = reuseTable(inventory)[0];
 assert.equal(row.donorPage, 1);
 assert.deepEqual(row.reusedOn, [4]);
 const donor = reusableProgram(inventory, {key, page: 4});
 assert.equal(donor.programPage, 1);
 assert.equal(donor.reused, true);
 assert.deepEqual([...donor.program], [0, 1, 2, 3]);

 const report = formatFontInventory(inventory, {page: 4});
 assert.match(report, /1 typeface across 4 pages/);
 assert.match(report, /program: page 1 · reused on page 4/);
 assert.match(report, /Page 4: ABCDEF\+OpenSans/);

 const summary = summarizeFontInventory(inventory);
 assert.equal(summary.types, 1);
 assert.equal(summary.fonts[0].donorPage, 1);
 assert.equal('program' in summary.fonts[0], false, 'raw font bytes stay out of the summary');
});

test('readFontResource resolves the Type0 descendant descriptor', async () => {
 const pdf = await newDocument();
 const font = await pdf.embedFont(ttf, {subset: true});
 pdf.addPage([200, 200]).drawText('Descendant check', {x: 20, y: 150, size: 12, font});
 const bytes = await pdf.save();
 const document = await L.PDFDocument.load(bytes, {updateMetadata: false});
 const fonts = document.getPage(0).node.Resources().lookup(L.PDFName.of('Font'), L.PDFDict);
 const resource = readFontResource(fonts.get(fonts.entries()[0][0]), document.context, L);
 assert.equal(resource.subtype, 'Type0');
 assert.equal(resource.embedded, true);
 assert.equal(resource.programKey, 'FontFile2');
 assert.ok(resource.program.length > 100);
});

test('producer-added numeric suffixes do not change the typeface identity', () => {
 assert.equal(fontKey('LiberationSans-7572'), fontKey('LiberationSans-91234'));
 assert.equal(fontKey('ABCDEF+OpenSans-Bold'), fontKey('ABCDEF+OpenSans-Bold-1234'));
 assert.equal(splitFontName('LiberationSans-7572').displayFamily, 'Liberation Sans');
 assert.notEqual(fontKey('Arial2'), fontKey('Arial'), 'short trailing digits stay part of the name');
});

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the command-line report names page 1 as the reuse donor', async () => {
 const pdf = await newDocument();
 const font = await pdf.embedFont(ttf, {subset: true});
 for (let i = 0; i < 3; i++) pdf.addPage([200, 200]).drawText(`Page ${i + 1} text`, {x: 20, y: 150, size: 12, font});
 const file = path.join(root, 'tests', '.font-report-sample.pdf');
 const {writeFile, rm} = await import('node:fs/promises');
 await writeFile(file, await pdf.save());
 try {
  const {stdout} = await execFileAsync(process.execPath, [path.join(root, 'tools', 'font-report.mjs'), file, '--page', '3']);
  assert.match(stdout, /3 pages/);
  assert.match(stdout, /program: page 1 · reused on pages 2, 3/);
  assert.match(stdout, /Reuse: .* from page 1 → pages 2, 3/);
  assert.match(stdout, /Page 3: /);
  const json = JSON.parse((await execFileAsync(process.execPath, [path.join(root, 'tools', 'font-report.mjs'), file, '--json'])).stdout);
  assert.equal(json.pageCount, 3);
  assert.equal(json.fonts[0].donorPage, 1);
  await assert.rejects(execFileAsync(process.execPath, [path.join(root, 'tools', 'font-report.mjs'), file, '--page', '9']));
 } finally {
  await rm(file, {force: true});
 }
});

test('page 1\'s font dictionary is reused on another page without re-embedding it', async () => {
 const pdf = await newDocument();
 const font = await pdf.embedFont(ttf, {subset: true});
 pdf.addPage([300, 200]).drawText('Hello world', {x: 20, y: 150, size: 12, font});
 pdf.addPage([300, 200]).drawText('Second page', {x: 20, y: 150, size: 12, font});
 const bytes = await pdf.save({useObjectStreams: true, addDefaultPage: false});

 const inventory = await buildDocumentFontInventory(bytes, L);
 const entry = inventory.fonts[0];
 const resourceName = inventory.pages[0].fonts[0].resourceName;
 const block = {
  id: '2:new:1', page: 2, text: 'Hello word', x: 20, y: 100, size: 12, lineheight: 1.2,
  font: 'PdfFontTest', fontName: entry.baseFont, color: '#000000', strokeColor: '#000000',
  textMode: 0, strokeWidth: 1, scaleX: 1, align: 'left', spacing: 0, wordSpacing: 0, ops: [], added: true,
 };
 const exported = await exportNativePdf({
  original: bytes, edits: new Map([[block.id, block]]),
  getPage: async () => ({info: {ops: []}, vp: {transform: [1, 0, 0, 1, 0, 0]}}),
  documentFonts: new Map([['PdfFontTest', {page: 1, resourceName}]]),
  fontkit, PDFLib: L,
 });

 const output = await L.PDFDocument.load(exported, {updateMetadata: false});
 const fonts = output.getPage(1).node.Resources().lookup(L.PDFName.of('Font'), L.PDFDict);
 const before = [...(await L.PDFDocument.load(bytes, {updateMetadata: false})).getPage(1).node.Resources().lookup(L.PDFName.of('Font'), L.PDFDict).keys()].map(key => key.toString());
 const pages = new Set(output.getPageCount() === 2 ? [0, 1] : []);
 assert.ok(pages.size === 2);
 // Both pages now point at the very same font object, so the program is not embedded twice.
 const pageOneFonts = output.getPage(0).node.Resources().lookup(L.PDFName.of('Font'), L.PDFDict);
 const pageTwoRefs = new Set([...fonts.entries()].map(([, ref]) => ref.toString()));
 const pageOneRefs = new Set([...pageOneFonts.entries()].map(([, ref]) => ref.toString()));
 assert.ok([...pageTwoRefs].some(ref => pageOneRefs.has(ref)), 'the page-2 resource reuses the page-1 font object');

 const stream = output.context.lookup(output.getPage(1).node.get(L.PDFName.of('Contents')));
 const text = Buffer.from(L.decodePDFRawStream(stream).decode()).toString('latin1');
 // The page already names this font, so that name is reused and no second
 // resource (and no second typeface copy) is added.
 assert.deepEqual([...fonts.keys()].map(key => key.toString()).sort(), before.sort(), 'no extra font resource is added');
 const selected = /(\/[A-Za-z0-9#_.+-]+) [\d.]+ Tf/.exec(text);
 assert.ok(selected && before.includes(selected[1]), 'the reused font is selected in the new content stream');
 assert.match(text, /TJ/, 'the text is drawn with the reused font codes');
});
