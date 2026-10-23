import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {maskText, amountShape, layoutReport} from '../tools/statement-layout.mjs';

const require = createRequire(import.meta.url);
const L = require('../dist/vendor/pdf-lib.min.js');
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('digits are masked and long words abbreviated, short headings survive', () => {
 assert.equal(maskText('1,099.88 Dr'), '#,###.## Dr');
 assert.equal(maskText('Date'), 'Date');
 assert.equal(maskText('UPAR/payment 16446982'), 'UPAR/pay… ########');
 assert.equal(maskText('AED 1,099.88 Dr', {reveal: true}), 'AED 1,099.88 Dr');
 assert.equal(amountShape('AED 1,099.88 Dr'), 'AED #,###.## Dr');
 assert.equal(amountShape('(451.00)'), '(###.##)');
 assert.equal(amountShape('02-02-2026'), null, 'a date is not an amount');
 assert.equal(amountShape('UPAR/payment 16446982'), null, 'narration is not an amount');
});

test('the layout report describes columns and rows without printing the numbers', () => {
 const report = layoutReport({
  pageCount: 1,
  pages: [{
   page: 1, width: 595, height: 842,
   items: [
    {text: 'Date', x: 40, y: 800, width: 20},
    {text: 'Narration', x: 110, y: 800, width: 40},
    {text: 'Amount', x: 470, y: 800, width: 30},
    {text: 'Balance', x: 560, y: 800, width: 32},
    {text: '02-02-2026', x: 40, y: 760, width: 60},
    {text: 'UPAR/payment', x: 110, y: 760, width: 80},
    {text: '1,099.88 Dr', x: 470, y: 760, width: 55},
    {text: '899.12', x: 560, y: 760, width: 40},
   ],
  }],
 });
 assert.match(report, /1 page$/m);
 assert.match(report, /Page 1 · 595×842 pt · 8 text runs · 2 rows \(1 with numbers\)/);
 assert.match(report, /numeric cells: x 470–470 \(#,###\.## Dr\), x 560–560 \(###\.##\)/);
 assert.doesNotMatch(report, /1,099\.88/, 'the amount itself is never printed');
 assert.match(report, /#,###\.## Dr/);
});

test('the command-line report runs on a PDF and masks its contents', async () => {
 const dir = await mkdtemp(path.join(tmpdir(), 'statement-layout-'));
 const file = path.join(dir, 'statement.pdf');
 try {
  const pdf = await L.PDFDocument.create();
  const font = await pdf.embedFont(L.StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  page.drawText('Balance', {x: 560, y: 800, size: 9, font});
  page.drawText('02-02-2026', {x: 40, y: 760, size: 9, font});
  page.drawText('UPAR/payment', {x: 110, y: 760, size: 9, font});
  page.drawText('1,099.88 Dr', {x: 470, y: 760, size: 9, font});
  page.drawText('899.12', {x: 560, y: 760, size: 9, font});
  await writeFile(file, await pdf.save());

  const {stdout} = await run(process.execPath, [path.join(root, 'tools', 'statement-layout.mjs'), file]);
  assert.match(stdout, /1 page/);
  assert.match(stdout, /Table columns|numeric cells/);
  assert.doesNotMatch(stdout, /1,099\.88/, 'digits stay masked');

  const revealed = await run(process.execPath, [path.join(root, 'tools', 'statement-layout.mjs'), file, '--reveal']);
  assert.match(revealed.stdout, /1,099\.88 Dr/, '--reveal prints the text as it is');

  const json = JSON.parse((await run(process.execPath, [path.join(root, 'tools', 'statement-layout.mjs'), file, '--json'])).stdout);
  assert.equal(json.pageCount, 1);
  assert.equal(json.pages[0].page, 1);
  assert.ok(json.pages[0].columns.length >= 2);
  assert.equal(json.pages[0].samples[0][0].text, 'Bal…', 'samples are masked too');
 } finally {
  await rm(dir, {recursive: true, force: true});
 }

 await assert.rejects(
  run(process.execPath, [path.join(root, 'tools', 'statement-layout.mjs')]),
  /Usage: node tools\/statement-layout\.mjs/,
 );
});
