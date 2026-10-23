import test from 'node:test';
import assert from 'node:assert/strict';
import {
 parseAmount, parseDate, formatAmountLike, groupRows, classifyRow, narrationCode,
 extractStatementRows, checkStatement, formatReport,
} from '../dist/statement-check.mjs';

// One page of blocks, laid out like a bank statement: date at x=40, narration at
// x=110, amount right-aligned at x=470, balance right-aligned at x=560.
function statementPage(rows, {page = 1, balanceX = 560, amountX = 470} = {}) {
 const blocks = [];
 // PDF.js viewport coordinates grow downwards, so later rows have a larger y.
 let y = 60;
 rows.forEach((row, index) => {
  y += 16;
  if (row.skip) return;
  if (row.date) blocks.push({id: `${page}:d${index}`, page, text: row.date, x: 40, y, width: 60, height: 10});
  blocks.push({id: `${page}:n${index}`, page, text: row.narration || 'narration', x: 110, y, width: 200, height: 10});
  if (row.amount) blocks.push({id: `${page}:a${index}`, page, text: row.amount, x: amountX, y, width: 70, height: 10});
  if (row.balance) blocks.push({id: `${page}:b${index}`, page, text: row.balance, x: balanceX, y, width: 70, height: 10});
 });
 return {page, blocks, originals: new Map()};
}

const cleanRows = [
 {date: '01-04-2026', narration: 'Opening balance', balance: '1,000.00'},
 {date: '02-04-2026', narration: 'UPAR/payment', amount: '500.00 Cr', balance: '1,500.00'},
 {date: '03-04-2026', narration: 'NEFT/transfer', amount: '250.00 Dr', balance: '1,250.00'},
 {date: '04-04-2026', narration: 'IMPS/refund', amount: '75.50 Cr', balance: '1,325.50'},
];

test('amounts are read with direction, currency and separators', () => {
 assert.equal(parseAmount('1,234.56').cents, 123456);
 assert.equal(parseAmount('1,234.56 Dr').cents, -123456);
 assert.equal(parseAmount('1,234.56 Cr').cents, 123456);
 assert.equal(parseAmount('(451.00)').cents, -45100);
 assert.equal(parseAmount('AED 1,099.88 Dr').cents, -109988);
 assert.equal(parseAmount('₩1,234.56').cents, 123456);
 for (const notAmount of ['02-02-2026', 'UPAR/payment', 'Page 1 of 24', 'narration', '', '1,2,3.4.5'])
  assert.equal(parseAmount(notAmount), null, `${JSON.stringify(notAmount)} is not an amount`);
});

test('statement dates are read in the common layouts and rejected otherwise', () => {
 assert.equal(parseDate('02-02-2026').iso, '2026-02-02');
 assert.equal(parseDate('02/02/2026').iso, '2026-02-02');
 assert.equal(parseDate('2026-02-02').iso, '2026-02-02');
 assert.equal(parseDate('2 Feb 2026').iso, '2026-02-02');
 assert.equal(parseDate('1,234.56'), null);
 assert.equal(parseDate('UPAR'), null);
});

test('a corrected balance is written in the shape of the cell it replaces', () => {
 assert.equal(formatAmountLike('1,234.56', 2340.5), '2,340.50');
 assert.equal(formatAmountLike('AED 1,099.88 Dr', -1234.5), 'AED 1,234.50 Dr');
 assert.equal(formatAmountLike('1,234.56 CR', -50), '50.00 DR');
 assert.equal(formatAmountLike('(1,000.00)', -250), '(250.00)');
 assert.equal(formatAmountLike('₩1,234.56', 99), '₩99.00');
 assert.equal(formatAmountLike('451.00', 451), '451.00');
});

test('rows are grouped by baseline and split into date, narration, amount and balance', () => {
 const row = {
  y: 640,
  blocks: [
   {id: 'a', text: 'UPAR/payment', x: 110, y: 640, height: 10},
   {id: 'b', text: '02-04-2026', x: 40, y: 641, height: 10},
   {id: 'c', text: '500.00 Cr', x: 470, y: 640, height: 10},
   {id: 'd', text: '1,500.00', x: 560, y: 640, height: 10},
  ],
 };
 const [group] = groupRows(row.blocks);
 const classified = classifyRow(group);
 assert.equal(classified.date.iso, '2026-04-02');
 assert.equal(classified.narration, 'UPAR/payment');
 assert.equal(classified.amount.amount.cents, 50000);
 assert.equal(classified.balance.amount.cents, 150000);
 assert.equal(narrationCode('UPAR/payment 451.00'), 'UPAR');
});

test('repeated page headers and titles are skipped, and a page is read once', () => {
 const page = statementPage([
  {skip: true},
  {date: '', narration: 'Account statement', balance: ''},
  {date: '', narration: 'Page 1 of 2', balance: ''},
  {date: '', narration: 'Brought forward', balance: '900.00'},
  {date: '01-04-2026', narration: 'Opening balance', balance: '1,000.00'},
  {date: '02-04-2026', narration: 'UPAR/payment', amount: '500.00 Cr', balance: '1,500.00'},
 ], {page: 1});
 // Title rows carry no balance, so they cannot look like transactions.
 const {rows} = extractStatementRows([page]);
 assert.equal(rows.length, 3);
 assert.equal(rows[0].narration, 'Brought forward');
 assert.equal(rows[0].page, 1);
 assert.equal(rows[2].amount.cents, 50000);

 const repeated = statementPage([
  {date: '', narration: 'Brought forward', balance: '1,500.00'},
  {date: '03-04-2026', narration: 'NEFT/transfer', amount: '250.00 Dr', balance: '1,250.00'},
 ], {page: 2});
 const both = extractStatementRows([page, repeated]);
 assert.equal(both.rows.filter(row => /brought forward/i.test(row.narration)).length, 0, 'a carried-forward header is not counted as a transaction');
});

test('a statement whose rows add up has no findings', () => {
 const report = checkStatement(extractStatementRows([statementPage(cleanRows)]).rows);
 assert.equal(report.ok, true);
 assert.equal(report.chainOk, true);
 assert.equal(report.rowCount, 4);
 assert.equal(report.opening, 1000);
 assert.equal(report.closing, 1325.5);
 assert.equal(report.credits, 575.5);
 assert.equal(report.debits, 250);
 assert.equal(report.net, 325.5);
 assert.equal(report.difference, 0);
 assert.equal(report.fixes.length, 0);
 assert.match(formatReport(report), /each row adds up/);
 assert.match(formatReport(report), /No arithmetic or direction problems found/);
});

test('an edited amount breaks the chain and the fix restores every following balance', () => {
 const edited = cleanRows.map(row => row.date === '03-04-2026' ? {...row, amount: '450.00 Dr'} : row);
 const report = checkStatement(extractStatementRows([statementPage(edited)]).rows);
 assert.equal(report.ok, false);
 const mismatch = report.issues.filter(item => item.code === 'balance_mismatch');
 assert.equal(mismatch.length, 2, 'the edited row and the row after it no longer match');
 assert.equal(mismatch[0].page, 1);
 assert.equal(mismatch[0].row, 3);
 assert.match(mismatch[0].message, /^balance 1,250\.00 does not match 1,050\.00/);
 assert.deepEqual(report.fixes.map(fix => [fix.row, fix.from, fix.to]), [[3, '1,250.00', '1,050.00'], [4, '1,325.50', '1,125.50']]);
 assert.equal(report.fixes[0].blockId, '1:b2', 'the fix targets the balance block that is on the page');
});

test('the opening balance is taken from the first row when no opening row exists', () => {
 const rows = [
  {date: '02-04-2026', narration: 'UPAR/payment', amount: '500.00 Cr', balance: '1,500.00'},
  {date: '03-04-2026', narration: 'NEFT/transfer', amount: '250.00 Dr', balance: '1,250.00'},
 ];
 const report = checkStatement(extractStatementRows([statementPage(rows)]).rows);
 assert.equal(report.opening, 1000, 'opening = first balance minus its amount');
 assert.equal(report.ok, true);
});

test('a row that contradicts the usual direction of its narration code is reported', () => {
 const rows = [
  {date: '01-04-2026', narration: 'Opening balance', balance: '1,000.00'},
  {date: '02-04-2026', narration: 'UPAR/payment', amount: '500.00 Dr', balance: '500.00'},
  {date: '03-04-2026', narration: 'UPAR/payment', amount: '100.00 Dr', balance: '400.00'},
  {date: '04-04-2026', narration: 'UPAR/payment', amount: '50.00 Dr', balance: '350.00'},
  {date: '05-04-2026', narration: 'UPAR/refund', amount: '25.00 Cr', balance: '375.00'},
 ];
 const report = checkStatement(extractStatementRows([statementPage(rows)]).rows);
 const direction = report.issues.filter(item => item.code === 'narration_direction');
 assert.equal(direction.length, 1);
 assert.equal(direction[0].row, 5);
 assert.match(direction[0].message, /UPAR\/refund/);
 assert.match(direction[0].message, /3 of 4 UPAR rows are DR/);
});

test('dates that go backwards are reported without breaking the arithmetic', () => {
 const rows = [
  {date: '01-04-2026', narration: 'Opening balance', balance: '1,000.00'},
  {date: '05-04-2026', narration: 'UPAR/payment', amount: '100.00 Cr', balance: '1,100.00'},
  {date: '02-04-2026', narration: 'NEFT/transfer', amount: '100.00 Dr', balance: '1,000.00'},
 ];
 const report = checkStatement(extractStatementRows([statementPage(rows)]).rows);
 assert.equal(report.chainOk, true);
 const order = report.issues.filter(item => item.code === 'date_order');
 assert.equal(order.length, 1);
 assert.equal(order[0].severity, 'suspicious');
 assert.match(order[0].message, /earlier than the row before it/);
});

test('the running balance continues across a page break', () => {
 const first = statementPage([
  {date: '01-04-2026', narration: 'Opening balance', balance: '1,000.00'},
  {date: '02-04-2026', narration: 'UPAR/payment', amount: '500.00 Cr', balance: '1,500.00'},
 ], {page: 1});
 const second = statementPage([
  {date: '', narration: 'Page 2 of 2', balance: ''},
  {date: '', narration: 'Brought forward', balance: '1,500.00'},
  {date: '03-04-2026', narration: 'NEFT/transfer', amount: '250.00 Dr', balance: '1,250.00'},
 ], {page: 2});
 const {rows} = extractStatementRows([first, second]);
 const report = checkStatement(rows);
 assert.equal(report.rowCount, 3, 'the carried-forward header is not a transaction');
 assert.equal(report.chainOk, true);
 assert.equal(report.closing, 1250);
 assert.equal(report.pages, 2);
});

test('an empty page set is reported instead of throwing', () => {
 const report = checkStatement([]);
 assert.equal(report.empty, true);
 assert.equal(report.ok, false);
 assert.match(formatReport(report), /No statement rows/);
});

test('the report lists pages, totals and each fix', () => {
 const edited = cleanRows.map(row => row.date === '02-04-2026' ? {...row, amount: '700.00 Cr'} : row);
 const report = checkStatement(extractStatementRows([statementPage(edited)]).rows);
 const text = formatReport(report);
 assert.match(text, /Statement check · 4 rows across 1 page/);
 assert.match(text, /Credits 775\.50 \(2 rows\) · Debits 250\.00 \(1 row\)/);
 assert.match(text, /page 1, row 2: 1,500\.00 → 1,700\.00/);
});
