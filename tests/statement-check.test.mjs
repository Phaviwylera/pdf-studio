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
  {date: '05-04-2026', narration: 'UPAR/payment to SNEHA', amount: '25.00 Cr', balance: '375.00'},
 ];
 const report = checkStatement(extractStatementRows([statementPage(rows)]).rows);
 const direction = report.issues.filter(item => item.code === 'narration_direction');
 assert.equal(direction.length, 1);
 assert.equal(direction[0].row, 5);
 assert.match(direction[0].message, /UPAR\/payment to SNEHA/);
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

// ---------------------------------------------------------------------------
// A statement printed the way a UAE/Indian bank prints one: the direction is in
// brackets after the number ("300.00(Dr)"), the balance carries "(Cr)" too, and
// the page holds a header, an account block and a "Page 1 of 2" footer whose
// numbers are further right than the balance column.

function bankPage(rows, {page = 1, of = 2} = {}) {
 const blocks = [];
 let y = 40;
 const push = (text, x, width = 60) => blocks.push({id: `${page}:${blocks.length}`, page, text, x, y, width, height: 9});
 push('Savings Account', 416, 70);
 y += 40;
 push('Date', 39, 20); push('Transaction Id', 77, 60); push('Remarks', 268, 40);
 push('Amount(', 444, 30); push(')', 488, 5); push('Balance(', 513, 30); push(')', 557, 5);
 y += 22;
 rows.forEach((row, index) => {
  push(row.date, 26, 50);
  push(row.id || `T${index}`, 85, 45);
  push(row.narration, 156, 280);
  if (row.amount) push(row.amount, row.amountX ?? 447.6, 43);
  if (row.balance) push(row.balance, row.balanceX ?? 516.6, 43);
  y += 22.5;
 });
 y = 815;
 push('Page', 542, 20); push(String(page), 559.6, 8); push('of', 569, 8); push(String(of), 578, 8);
 return {page, blocks, originals: new Map(blocks.map(block => [block.id, {...block}]))};
}

const bankRows = [
 {date: '02-04-2026', id: 'Y64949982', narration: 'UPIAR/609237358835/DR/Mahalaks/YESB/paytmqrifytgxs', amount: '100.00(Dr)', balance: '394.57(Cr)'},
 {date: '02-04-2026', id: 'Y65401285', narration: 'UPIAR/609251850281/DR/NEW MANN/CNRB/ppr.01835.2406', amount: '12.00(Dr)', balance: '382.57(Cr)'},
 {date: '03-04-2026', id: 'S16801498', narration: 'UPIAB/609326015267/CR/ SNEHA A/ICIC/snehachristina', amount: '2000.00(Cr)', amountX: 442.6, balance: '2382.57(Cr)', balanceX: 511.6},
 {date: '03-04-2026', id: 'S30340765', narration: 'UPIAR/645913740249/DR/Google I/UTIB/gpayrecharge@o', amount: '49.00(Dr)', amountX: 452.6, balance: '2333.57(Cr)'},
];

test('amounts written as "12.00(Dr)" are read, and ids are not money', () => {
 assert.equal(parseAmount('100.00(Dr)').cents, -10000);
 assert.equal(parseAmount('394.57(Cr)').cents, 39457);
 assert.equal(parseAmount('1,234.56(CR)').cents, 123456);
 assert.equal(parseAmount('12.00 (Dr)').cents, -1200);
 // A transaction id, an IFSC code and an account number are not amounts.
 for (const notAmount of ['Y64949982', 'S16801498', 'UBIN0557048', '570402010010517', 'T17305718'])
  assert.equal(parseAmount(notAmount), null, `${notAmount} is not an amount`);
});

test('a fix keeps the bracketed direction style of the cell it replaces', () => {
 assert.equal(formatAmountLike('394.57(Cr)', 402.57), '402.57(Cr)');
 assert.equal(formatAmountLike('100.00(Dr)', 88.5), '88.50(Cr)');
 assert.equal(formatAmountLike('1,000.00(Cr)', -1234.5), '1,234.50(Dr)');
 assert.equal(formatAmountLike('2,000.00(Dr)', 0), '0.00(Cr)');
});

test('the header, the account block and the page footer stay out of the chain', () => {
 const page = bankPage(bankRows, {page: 1, of: 2});
 // Numbers that are not table cells: a CIF id in the amount column and the page
 // footer, whose digits sit to the right of the balance column.
 page.blocks.push({id: 'cif', page: 1, text: '622719504', x: 438.2, y: 20, width: 50, height: 9});
 page.blocks.push({id: 'acct', page: 1, text: '570402010010517', x: 438.2, y: 24, width: 80, height: 9});
 const {rows, columns} = extractStatementRows([page]);
 assert.ok(columns, 'the amount and balance columns are found');
 assert.equal(rows.length, 4, 'only the four transactions are rows');
 assert.equal(rows[0].narration.startsWith('UPIAR/609237358835'), true);
 assert.equal(rows[0].amount.cents, -10000);
 assert.equal(rows[0].balance.cents, 39457);
 const report = checkStatement(rows);
 assert.equal(report.opening, 494.57, 'opening = first balance minus its amount');
 assert.equal(report.chainOk, true);
 assert.equal(report.ok, true, formatReport(report));
});

test('an edited amount in this layout reports the row and fixes the balances after it', () => {
 const edited = bankRows.map(row => row.id === 'Y65401285' ? {...row, amount: '1,012.00(Dr)'} : row);
 const {rows} = extractStatementRows([bankPage(edited)]);
 const report = checkStatement(rows);
 assert.equal(report.chainOk, false);
 assert.equal(report.issues[0].row, 2);
 assert.equal(report.issues[0].page, 1);
 assert.match(report.issues[0].message, /balance 382\.57\(Cr\) does not match 617\.43\(Dr\)/);
 assert.deepEqual(report.fixes.map(fix => [fix.from, fix.to]), [
  ['382.57(Cr)', '617.43(Dr)'],
  ['2382.57(Cr)', '1382.57(Cr)'],
  ['2333.57(Cr)', '1333.57(Cr)'],
 ]);
 const text = formatReport(report);
 assert.match(text, /Statement check · 4 rows across 1 page/);
 assert.match(text, /page 1, row 2: 382\.57\(Cr\) → 617\.43\(Dr\)/);
});

test('a refund or reversal is not reported as a direction outlier', () => {
 const rows = [
  {date: '01-04-2026', id: 'Y64949982', narration: 'UPIAR/609237358835/DR/Mahalaks', amount: '100.00(Dr)', balance: '900.00(Cr)'},
  {date: '02-04-2026', id: 'Y65401285', narration: 'UPIAR/609251850281/DR/NEW MANN', amount: '12.00(Dr)', balance: '888.00(Cr)'},
  {date: '03-04-2026', id: 'Y65111873', narration: 'UPIAR/609292955913/DR/Supriya', amount: '77.00(Dr)', balance: '811.00(Cr)'},
  // A reversed debit comes back as a credit: the same code, the other direction.
  {date: '04-04-2026', id: 'A4', narration: 'UPIAR/618220429989/REV/609237358835', amount: '100.00(Cr)', balance: '911.00(Cr)'},
  {date: '05-04-2026', id: 'A5', narration: 'UPIAR/refund of charge', amount: '5.00(Cr)', balance: '916.00(Cr)'},
 ];
 const report = checkStatement(extractStatementRows([bankPage(rows)]).rows);
 assert.equal(report.chainOk, true);
 assert.equal(report.issues.filter(item => item.code === 'narration_direction').length, 0, formatReport(report));
});

test('the narration code is read from the remarks, not from the transaction id', () => {
 const rows = [
  {date: '01-04-2026', id: 'Y64949982', narration: 'UPIAR/609237358835/DR/Mahalaks', amount: '100.00(Dr)', balance: '900.00(Cr)'},
  {date: '02-04-2026', id: 'Y65401285', narration: 'UPIAR/609251850281/DR/NEW MANN', amount: '12.00(Dr)', balance: '888.00(Cr)'},
  {date: '03-04-2026', id: 'Y74034580', narration: 'UPIAR/609292955913/DR/Supriya', amount: '77.00(Dr)', balance: '811.00(Cr)'},
  {date: '04-04-2026', id: 'Y99364235', narration: 'UPIAB/609232895271/CR/N KAMALA', amount: '12.00(Cr)', balance: '823.00(Cr)'},
  {date: '05-04-2026', id: 'Y99364236', narration: 'UPIAR/609232895272/DR/typo credit', amount: '12.00(Cr)', balance: '835.00(Cr)'},
 ];
 const {rows: parsed} = extractStatementRows([bankPage(rows)]);
 assert.equal(parsed[0].narration.startsWith('UPIAR/'), true, 'the transaction id is not part of the narration');
 const report = checkStatement(parsed);
 const direction = report.issues.filter(item => item.code === 'narration_direction');
 assert.equal(direction.length, 1, formatReport(report));
 assert.match(direction[0].message, /3 of 4 UPIAR rows are DR/);
});

test('a stale /DR/ marker in the remarks is reported, not silently rewritten', () => {
 // The amount was turned into a credit but the remarks still say DR.
 const rows = [
  {date: '01-04-2026', id: 'Y64949982', narration: 'UPIAR/609237358835/DR/Mahalaks', amount: '100.00(Dr)', balance: '900.00(Cr)'},
  {date: '02-04-2026', id: 'Y65401285', narration: 'UPIAR/609251850281/DR/NEW MANN', amount: '50.00(Cr)', balance: '950.00(Cr)'},
 ];
 const report = checkStatement(extractStatementRows([bankPage(rows)]).rows);
 const marker = report.issues.filter(item => item.code === 'narration_marker');
 assert.equal(marker.length, 1, formatReport(report));
 assert.match(marker[0].message, /narration says \/DR\/ but the amount 50\.00\(Cr\) is marked CR/);
 assert.equal(report.fixes.length, 0, 'a marker is never auto-edited');
});

test('an edited amount is listed so the change is visible before the balances move', () => {
 const edited = bankRows.map(row => row.id === 'S16801498' ? {...row, amount: '200.00(Cr)'} : row);
 const page = bankPage(edited);
 // The document original keeps the value that was there before the edit.
 for (const block of page.originals.values()) if (block.text === '200.00(Cr)') block.text = '2000.00(Cr)';
 const report = checkStatement(extractStatementRows([page]).rows);
 assert.equal(report.editedAmounts.length, 1, formatReport(report));
 assert.deepEqual([report.editedAmounts[0].page, report.editedAmounts[0].row], [1, 3]);
 assert.equal(report.editedAmounts[0].from, '2000.00(Cr)');
 assert.equal(report.editedAmounts[0].to, '200.00(Cr)');
 const text = formatReport(report);
 assert.match(text, /Edited amounts \(1 row; the balances follow these\)/);
 assert.match(text, /page 1, row 3: 2000\.00\(Cr\) → 200\.00\(Cr\)/);
});

test('a remarks code that contradicts the row direction is offered as a fix', () => {
 const rows = [
  {date: '02-04-2026', id: 'Y64949982', narration: 'UPIAR/1/DR/Mahalaks', amount: '100.00(Dr)', balance: '850.00(Cr)'},
  {date: '02-04-2026', id: 'Y65401285', narration: 'UPIAR/2/DR/Mahalaks', amount: '100.00(Dr)', balance: '750.00(Cr)'},
  {date: '02-04-2026', id: 'Y65111873', narration: 'UPIAR/3/DR/Mahalaks', amount: '100.00(Dr)', balance: '650.00(Cr)'},
  {date: '03-04-2026', id: 'S16801498', narration: 'UPIAB/4/CR/ SNEHA A', amount: '50.00(Cr)', amountX: 442.6, balance: '700.00(Cr)', balanceX: 511.6},
  {date: '03-04-2026', id: 'S30340765', narration: 'UPIAB/5/CR/ SNEHA A', amount: '50.00(Cr)', amountX: 442.6, balance: '750.00(Cr)', balanceX: 511.6},
  // The edited row: a debit turned into a credit, remarks and direction swapped
  // but the narration code left behind.
  {date: '04-04-2026', id: 'T17305718', narration: 'UPIAR/6/CR/Mahalaks', amount: '100.00(Cr)', amountX: 442.6, balance: '850.00(Cr)', balanceX: 511.6},
 ];
 const page = bankPage(rows, {page: 1, of: 2});
 const {rows: extracted} = extractStatementRows([page]);
 const report = checkStatement(extracted);
 const issue = report.issues.find(entry => entry.code === 'narration_direction');
 assert.ok(issue, 'the lone opposite-direction row is reported');
 assert.match(issue.message, /UPIAB/, 'the message names the credit code this statement uses');
 const fix = report.fixes.find(entry => entry.kind === 'narration');
 assert.equal(fix.from, 'UPIAR/6/CR/Mahalaks');
 assert.equal(fix.to, 'UPIAB/6/CR/Mahalaks');
 // Nothing else was rewritten: the chain already adds up.
 assert.equal(report.fixes.filter(entry => entry.kind !== 'narration').length, 0);
});
