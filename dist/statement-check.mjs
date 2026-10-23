// Statement arithmetic for PDF text blocks extracted by the viewer.
//
// A bank statement is checked the way a reader checks it: every row must have a
// date, a narration, an amount with a direction (Dr/Cr) and a running balance,
// and balance(n) must equal balance(n-1) + amount(n). Everything here works on
// the blocks the editor already has ({page, text, x, y, height}), so it needs no
// PDF parsing and no network access.

export const BALANCE_TOLERANCE = 0.005;
const MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12};

const toCents = value => Math.round(Number(value) * 100);
const fromCents = value => Math.round(value) / 100;

// ---------------------------------------------------------------------------
// Values

/** A currency prefix is a symbol, or a three-letter code — never an id prefix. */
const CURRENCY_SYMBOL = /^(?:₹|₩|¥|€|£|\$|₺|₽|₦|₱|฿|Rs\.?|R\$|S\$|HK\$|US\$|A\$|C\$)$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

function isCurrencyPrefix(prefix) {
 const value = prefix.replace(/\s+/g, ' ').trim();
 if (!value) return true;
 return CURRENCY_SYMBOL.test(value) || CURRENCY_CODE.test(value);
}

/**
 * Read one amount cell: "1,234.56", "1,234.56 Dr", "12.00(Dr)", "(451.00)",
 * "AED 1,234.56 Cr", "₩1,234.56". Returns null for anything that is not a single
 * amount — a date, narration, column header, page number, transaction id
 * ("Y64949982") or IFSC code ("UBIN0557048").
 */
export function parseAmount(text) {
 if (typeof text !== 'string') return null;
 let rest = text.replace(/\u00a0/g, ' ').trim();
 if (!rest || rest.length > 48) return null;
 // Direction: "12.00(Dr)" and "12.00 (Cr)" put it in brackets, "12.00 Dr" after a
 // space. Both mean the same thing; the brackets are how some banks print it.
 let drcr = null, directionInParentheses = false;
 let match = /\(\s*(dr|cr)\s*\)\s*$/i.exec(rest);
 if (match) {
  drcr = match[1].toUpperCase();
  directionInParentheses = true;
  rest = rest.slice(0, match.index).trim();
 } else if ((match = /(?:^|[\s)])(dr|cr)\.?$/i.exec(rest))) {
  drcr = match[1].toUpperCase();
  rest = rest.slice(0, match.index).trim();
 }
 if (!rest) return null;
 let negative = false;
 if (/^\(.*\)$/.test(rest)) { negative = true; rest = rest.slice(1, -1).trim(); }
 // A currency prefix is the run of non-digits before the first digit.
 const prefix = /^[^\d]*/.exec(rest)[0];
 const currency = prefix.trim();
 if (!isCurrencyPrefix(currency)) return null;
 rest = rest.slice(prefix.length);
 if (!/^-?\d[\d, ]*(?:\.\d{1,3})?$/.test(rest)) return null;
 // An account number or a reference is a long run of digits, not money.
 const digits = rest.replace(/\D/g, '');
 if (digits.length > 13) return null;
 const decimals = (rest.split('.')[1] || '').length;
 const thousands = rest.includes(',');
 const body = rest.replace(/[\s]/g, '');
 const value = Number(body.replace(/,/g, ''));
 if (!Number.isFinite(value)) return null;
 const signed = drcr === 'DR' ? -Math.abs(value) : drcr === 'CR' ? Math.abs(value) : (negative ? -Math.abs(value) : value);
 return {
  value: signed, cents: toCents(signed),
  drcr, directionInParentheses, currency, decimals, thousands, parentheses: negative, raw: text.trim(),
 };
}

/** Read a statement date: 02-02-2026, 02/02/2026, 2026-02-02, 02 Feb 2026. */
export function parseDate(text) {
 if (typeof text !== 'string') return null;
 const value = text.replace(/\u00a0/g, ' ').trim();
 if (!value || value.length > 24) return null;
 let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
 let year, month, day;
 if (match) [, year, month, day] = match;
 else if ((match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(value))) {
  [, day, month, year] = match;
  if (year.length === 2) year = `20${year}`;
 } else if ((match = /^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-](\d{2,4})$/.exec(value))) {
  [, day, month, year] = match;
  month = MONTHS[month.toLowerCase()];
  if (year.length === 2) year = `20${year}`;
 } else if ((match = /^(\d{1,2})[\s-]([A-Za-z]{3,9})$/.exec(value))) {
  // "02 Feb" — the year belongs to the statement, so order is kept within a page.
  [, day, month] = match;
  month = MONTHS[month.toLowerCase()];
  year = '0000';
 } else return null;
 const numbers = [year, month, day].map(Number);
 if (numbers.some(number => !Number.isInteger(number))) return null;
 if (numbers[1] < 1 || numbers[1] > 12 || numbers[2] < 1 || numbers[2] > 31) return null;
 const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
 return {iso, year: numbers[0], month: numbers[1], day: numbers[2], raw: value};
}

/**
 * Write a value in the same shape as the cell it replaces: same currency prefix,
 * same thousands separator, same decimals, same Dr/Cr suffix or parentheses.
 */
export function formatAmountLike(sample, value) {
 const parsed = parseAmount(sample);
 const decimals = parsed?.decimals ?? 2;
 const thousands = parsed?.thousands ?? true;
 const currency = parsed?.currency ?? '';
 const absolute = Math.abs(Number(value) || 0).toFixed(decimals);
 let [whole, fraction] = absolute.split('.');
 if (thousands) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
 const body = fraction ? `${whole}.${fraction}` : whole;
 const negative = (Number(value) || 0) < 0;
 const gap = /^[A-Za-z]+$/.test(currency) ? ' ' : '';
 const prefix = `${currency}${gap}`;
 const suffix = parsed?.drcr;
 // The direction follows the value; the sample only supplies how it is written.
 if (suffix) {
  // Keep the casing the document used ("Dr" vs "DR").
  const written = /(?:^|[\s)])(dr|cr)\.?$/i.exec((parsed?.raw || '').replace(/\(\s*(dr|cr)\s*\)\s*$/i, ' $1'))?.[1] || suffix;
  const style = written === written.toUpperCase() ? {dr: 'DR', cr: 'CR'} : {dr: 'Dr', cr: 'Cr'};
  const direction = negative ? style.dr : style.cr;
  // "12.00(Dr)" and "12.00 Dr" are both common; match the cell being replaced.
  return parsed?.directionInParentheses ? `${prefix}${body}(${direction})` : `${prefix}${body} ${direction}`;
 }
 if (negative && parsed?.parentheses) return `${prefix}(${body})`;
 return `${prefix}${negative ? `-${body}` : body}`;
}

// ---------------------------------------------------------------------------
// Rows

/** Group blocks that share a baseline into one visual row, left to right. */
export function groupRows(blocks, {tolerance = 2.5} = {}) {
 const rows = [];
 const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
 for (const block of sorted) {
  const row = rows[rows.length - 1];
  const limit = Math.max(tolerance, (row?.blocks[0].height || block.height || 0) / 2);
  if (row && Math.abs(block.y - row.y) <= limit) row.blocks.push(block);
  else rows.push({y: block.y, blocks: [block]});
 }
 for (const row of rows) row.blocks.sort((a, b) => a.x - b.x);
 return rows;
}

// Numeric columns are found from the rows that carry a date, because headers,
// page footers ("Page 1 of 24") and account details sit on the same page but are
// not part of the table. A statement may right-align its money, so a column is
// searched with a little slack either side of the numbers it was built from.
const BAND_SLACK = 14;
const BAND_GAP = 12;

/**
 * Find the amount and balance columns from the rows of a statement.
 * A column is a run of numeric cells at (nearly) the same x that most dated rows
 * share. The rightmost column is the running balance, the one before it the
 * amount. Returns null when the layout cannot be read that way, and the caller
 * then falls back to reading each row on its own.
 */
export function detectColumns(groups) {
 const dated = [], samples = [];
 for (const group of groups) {
  const hasDate = group.blocks.some(block => parseDate(block.text));
  if (!hasDate) continue;
  dated.push(group);
  for (const block of group.blocks) if (parseAmount(block.text)) samples.push(block.x);
 }
 if (dated.length < 2 || samples.length < dated.length) return null;
 samples.sort((a, b) => a - b);
 const bands = [];
 for (const x of samples) {
  const band = bands[bands.length - 1];
  if (band && x - band.max <= BAND_GAP) band.max = x;
  else bands.push({min: x, max: x, count: 0});
 }
 for (const band of bands) band.count = samples.filter(x => x >= band.min && x <= band.max).length;
 // A column has to appear on most rows, or it is a stray number.
 const useful = bands.filter(band => band.count >= Math.max(2, dated.length * 0.4));
 if (useful.length < 2) return null;
 // Join neighbours that are too close to be told apart.
 const merged = [];
 for (const band of useful) {
  const last = merged[merged.length - 1];
  if (last && band.min - last.max < 8) { last.max = Math.max(last.max, band.max); last.count += band.count; }
  else merged.push({...band});
 }
 if (merged.length < 2) return null;
 const amount = merged[merged.length - 2], balance = merged[merged.length - 1];
 return {
  amount: {min: amount.min, max: amount.max},
  balance: {min: balance.min, max: balance.max},
  rows: dated.length,
 };
}

/** A reference number rather than words: "Y64949982", "622719504". */
function isReference(text) {
 const value = String(text || '').trim();
 return /^[A-Z]{1,2}\d{5,16}$/.test(value) || /^\d{6,}$/.test(value);
}

const inBand = (block, band) => !!band && block.x >= band.min - BAND_SLACK && block.x <= band.max + BAND_SLACK;

/** Split one visual row into date, narration, amount and balance cells. */
export function classifyRow(row, columns = null) {
 const cells = row.blocks.map(block => ({block, amount: parseAmount(block.text), date: parseDate(block.text)}));
 const dateCell = cells.find(cell => cell.date) || null;
 const numeric = cells.filter(cell => cell.amount);
 let balance = null, amount = null;
 if (columns) {
  balance = numeric.find(cell => inBand(cell.block, columns.balance)) || null;
  amount = numeric.find(cell => inBand(cell.block, columns.amount) && cell !== balance) || null;
 }
 // Without a column layout, or on a dated row whose numbers sit outside the
 // columns found for the table, the row is read on its own. A dated row is a
 // transaction, so its geometry is trusted over a column it does not line up
 // with. A row with no date (header, footer, account block) gets no such second
 // chance: it has to land in the columns to count.
 if (!columns || (dateCell && (!balance || (!amount && numeric.length >= 2)))) {
  // The rightmost number is the balance, the one before it the amount. A single
  // number with a direction suffix is an amount, otherwise a running balance.
  if (numeric.length >= 2) {
   balance = numeric[numeric.length - 1];
   amount = numeric[numeric.length - 2];
  } else if (numeric.length === 1) {
   if (numeric[0].amount.drcr) amount = numeric[0];
   else balance = numeric[0];
  }
 }
 const used = new Set([dateCell, amount, balance].filter(Boolean));
 // The narration is what is left: the remarks column. A transaction id
 // ("Y64949982") or an account number next to it is a reference, not prose, and
 // leaving it in would hide the narration code that starts the remarks.
 const narration = cells
  .filter(cell => !used.has(cell))
  .map(cell => cell.block.text)
  .filter(text => !isReference(text))
  .join(' ').trim();
 return {date: dateCell?.date || null, dateBlock: dateCell?.block || null, narration, amount, balance, cells};
}

const DIRECTION = [/^([A-Za-z]{2,10})\b/];
// A refund, return or reversal is the one time a code legitimately takes the
// other direction, so those rows never count as an outlier.
const REVERSAL = /(?:^|[^A-Za-z])(reversal|reversed|refund|refunded|return|returned|chargeback|rev)(?:[^A-Za-z]|$)/i;

/** The leading code of a narration ("UPAR/payment", "NEFT CR", "IMPS/…"). */
export function narrationCode(text) {
 const value = String(text || '').trim();
 for (const pattern of DIRECTION) {
  const match = pattern.exec(value);
  if (match) return match[1].toUpperCase();
 }
 return '';
}

/**
 * Extract statement rows from pages of blocks. Repeated page headers, column
 * titles and "Page 3 of 24" lines are skipped, so one transaction is counted once.
 * `originals` maps block id → the block as it was before any edit.
 */
export function extractStatementRows(pages, {tolerance = 2.5} = {}) {
 const rows = [], skipped = [];
 const seenText = new Map();
 // Group every page first: the column layout is a property of the whole
 // statement, so it is read from all the dated rows before any row is classified.
 const layout = pages.map(page => ({
  page,
  pageNumber: Number(page.page) || 1,
  originals: page.originals instanceof Map ? page.originals : new Map(),
  groups: groupRows(page.blocks, {tolerance}),
 }));
 const columns = detectColumns(layout.flatMap(entry => entry.groups));
 for (const {pageNumber, originals, groups} of layout) {
  for (const group of groups) {
   const classified = classifyRow(group, columns);
   const text = group.blocks.map(block => block.text).join(' ').replace(/\s+/g, ' ').trim();
   const header = pageFromHeader(text);
   // "Page 1 of 24" is a page label even when its digits are the only numbers on
   // the line, so it can never become a transaction.
   if (header && /^page\s+\d+\s+of\s+\d+$/i.test(text)) continue;
   if (!classified.balance && !classified.date) continue; // titles, headers
   // With a column layout known, a balance has to sit in the balance column: this
   // is what keeps account numbers, CIF ids and "Page 2 of 24" out of the chain.
   if (!classified.balance) { skipped.push({page: pageNumber, text, reason: 'no balance'}); continue; }
   // Repeated page headers repeat their narration, not their figures.
   const key = (classified.narration || text).toLowerCase().replace(/\s+/g, ' ').trim();
   const pagesSeen = seenText.get(key) || new Set();
   pagesSeen.add(pageNumber);
   seenText.set(key, pagesSeen);
   const originalBalance = originals.get(classified.balance.block.id) || null;
   const originalAmount = classified.amount ? originals.get(classified.amount.block.id) || null : null;
   rows.push({
    page: pageNumber,
    pageLabel: header,
    y: group.y,
    date: classified.date,
    narration: classified.narration,
    amount: classified.amount ? {
     cents: classified.amount.amount.cents,
     value: classified.amount.amount.value,
     drcr: classified.amount.amount.drcr,
     text: classified.amount.block.text,
     blockId: classified.amount.block.id,
     x: classified.amount.block.x,
     y: classified.amount.block.y,
     originalCents: originalAmount ? parseAmount(originalAmount.text)?.cents ?? null : null,
    } : null,
    balance: {
     cents: classified.balance.amount.cents,
     value: classified.balance.amount.value,
     text: classified.balance.block.text,
     blockId: classified.balance.block.id,
     x: classified.balance.block.x,
     y: classified.balance.block.y,
     originalCents: originalBalance ? parseAmount(originalBalance.text)?.cents ?? null : null,
    },
    text,
   });
  }
 }
 // A row that repeats unchanged on two or more pages is a carried-forward header,
 // not a transaction: count each transaction once. Reading order is by page, then
 // by baseline, which is the order the arithmetic has to follow.
 const ordered = rows
  .filter(row => !(row.date === null && !row.amount && (seenText.get((row.narration || row.text).toLowerCase().replace(/\s+/g, ' ').trim())?.size || 0) > 1))
  .sort((a, b) => a.page - b.page || a.y - b.y);
 return {rows: ordered, skipped, columns};
}

function pageFromHeader(text) {
 const match = /page\s+(\d+)\s+of\s+(\d+)/i.exec(text || '');
 return match ? {page: Number(match[1]), of: Number(match[2])} : null;
}

// ---------------------------------------------------------------------------
// Checks

function issue(code, severity, row, message, extra = {}) {
 return {code, severity, page: row?.page ?? null, row: row?.number ?? null, message, ...extra};
}

/**
 * Verify a statement: opening balance, running balance, date order and the
 * direction each narration code normally takes. Rows with an amount are treated
 * as authoritative, so the corrected balances follow from the amounts.
 */
export function checkStatement(rows, {tolerance = BALANCE_TOLERANCE} = {}) {
 const limit = Math.max(1, Math.round(tolerance * 100));
 const issues = [], checked = [], edited = [];
 const transactions = rows.filter(row => row.balance && (row.amount || row.date));
 if (!transactions.length) {
  return {ok: false, empty: true, rowCount: 0, issues: [issue('statement_empty', 'serious', null, 'No statement rows were found on these pages.')], rows: [], fixes: [], totals: null};
 }
 const first = transactions[0];
 // Opening balance: an opening row carries it; otherwise it is the first row's
 // own balance minus its amount, using the values before any edit.
 const openingCents = first.amount
  ? (first.balance.originalCents ?? first.balance.cents) - (first.amount.originalCents ?? first.amount.cents)
  : (first.balance.originalCents ?? first.balance.cents);
 let running = openingCents, previousDate = null, mismatches = 0;
 const fixes = [];
 let credits = 0, debits = 0, creditRows = 0, debitRows = 0;
 const directions = new Map();
 transactions.forEach((row, position) => {
  const number = position + 1;
  const entry = {number, page: row.page, date: row.date?.iso || null, narration: row.narration, amount: row.amount ? fromCents(row.amount.cents) : null, balance: fromCents(row.balance.cents), expected: null, delta: null, checks: []};
  if (row.amount) {
   running += row.amount.cents;
   if (row.amount.cents > 0) {credits += row.amount.cents; creditRows++;}
   else if (row.amount.cents < 0) {debits += Math.abs(row.amount.cents); debitRows++;}
   // An amount that was typed by hand is the reason the balances below it move,
   // and it is the one thing a validator comparing against the original sees.
   if (row.amount.originalCents != null && row.amount.originalCents !== row.amount.cents)
    edited.push({page: row.page, row: number, from: formatAmountLike(row.amount.text, fromCents(row.amount.originalCents)), to: row.amount.text});
   // The remarks often repeat the direction ("UPIAR/…/DR/…"). If the amount says
   // the opposite, one of the two was edited and the other was left behind.
   const marker = /\/(DR|CR)\//i.exec(row.narration || '');
   if (marker && row.amount.drcr && marker[1].toUpperCase() !== row.amount.drcr) {
    entry.checks.push('narration_marker');
    issues.push(issue('narration_marker', 'serious', {...row, number}, `narration says /${marker[1].toUpperCase()}/ but the amount ${row.amount.text} is marked ${row.amount.drcr}.`));
   }
   if (row.amount.drcr && row.narration && !REVERSAL.test(row.narration)) {
    const code = narrationCode(row.narration);
    if (code) {
     const tally = directions.get(code) || {CR: 0, DR: 0};
     tally[row.amount.drcr === 'CR' ? 'CR' : 'DR']++;
     directions.set(code, tally);
    }
   }
  }
  const expected = running;
  entry.expected = fromCents(expected);
  entry.delta = fromCents(row.balance.cents - expected);
  if (Math.abs(row.balance.cents - expected) > limit) {
   mismatches++;
   entry.checks.push('balance_mismatch');
   issues.push(issue('balance_mismatch', 'serious', {...row, number}, `balance ${row.balance.text} does not match ${formatAmountLike(row.balance.text, fromCents(expected))} (running balance after ${row.amount ? row.amount.text : 'the previous row'}).`, {expected, actual: row.balance.cents, delta: row.balance.cents - expected}));
   fixes.push({page: row.page, row: number, blockId: row.balance.blockId, from: row.balance.text, to: formatAmountLike(row.balance.text, fromCents(expected)), x: row.balance.x, y: row.balance.y, expected: fromCents(expected)});
  }
  if (row.date) {
   if (previousDate && row.date.iso < previousDate.iso) {
    entry.checks.push('date_order');
    issues.push(issue('date_order', 'suspicious', {...row, number}, `date ${row.date.raw} is earlier than the row before it (${previousDate.raw}).`));
   }
   previousDate = row.date;
  }
  checked.push(entry);
 });
 // Direction consistency: a narration code keeps one direction across a statement.
 for (const [code, tally] of [...directions].sort((a, b) => (b[1].CR + b[1].DR) - (a[1].CR + a[1].DR))) {
  const total = tally.CR + tally.DR;
  if (total < 3) continue;
  const majority = tally.CR >= tally.DR ? 'CR' : 'DR';
  // Only a code that clearly keeps one direction can expose an outlier.
  if (Math.max(tally.CR, tally.DR) / total < 0.7) continue;
  for (const row of transactions) {
   if (!row.amount?.drcr || !row.date) continue;
   if (REVERSAL.test(row.narration || '')) continue;
   if (narrationCode(row.narration) !== code) continue;
   if (row.amount.drcr === majority) continue;
   const number = transactions.indexOf(row) + 1;
   if (checked[number - 1].checks.includes('narration_direction')) continue;
   checked[number - 1].checks.push('narration_direction');
   issues.push(issue('narration_direction', 'serious', {...row, number}, `narration ${row.narration.slice(0, 24)} is marked ${row.amount.drcr} while ${tally[majority]} of ${total} ${code} rows are ${majority}.`));
  }
 }
 const closingCents = transactions[transactions.length - 1].balance.cents;
 const net = credits - debits;
 const difference = closingCents - openingCents - net;
 issues.sort((a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.row ?? 0) - (b.row ?? 0));
 return {
  ok: issues.length === 0,
  empty: false,
  pages: new Set(rows.map(row => row.page)).size,
  rowCount: transactions.length,
  issues,
  fixes,
  credits: fromCents(credits),
  debits: fromCents(debits),
  net: fromCents(net),
  creditRows,
  debitRows,
  opening: fromCents(openingCents),
  closing: fromCents(closingCents),
  difference: fromCents(difference),
  chainOk: mismatches === 0,
  editedAmounts: edited,
  rows: checked,
 };
}

/** A short, copyable report for the dialog and the console. */
export function formatReport(report) {
 if (!report || report.empty) return 'No statement rows were found. This check needs a table with dates, amounts and a running balance.';
 const money = value => `${value < 0 ? '-' : ''}${Math.abs(value).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
 const lines = [
  `Statement check · ${report.rowCount} rows across ${report.pages} page${report.pages === 1 ? '' : 's'}`,
  `Opening ${money(report.opening)} · Closing ${money(report.closing)} · Net ${money(report.net)}`,
  `Credits ${money(report.credits)} (${report.creditRows} row${report.creditRows === 1 ? '' : 's'}) · Debits ${money(report.debits)} (${report.debitRows} row${report.debitRows === 1 ? '' : 's'})`,
  `Balance chain: ${report.chainOk ? 'each row adds up' : `${report.fixes.length} row${report.fixes.length === 1 ? '' : 's'} do not add up`}`,
 ];
 if (report.difference !== 0) lines.push(`Closing minus opening differs from the net by ${money(report.difference)}`);
 if (!report.issues.length) lines.push('', 'No arithmetic or direction problems found.');
 else {
  lines.push('', `${report.issues.length} problem${report.issues.length === 1 ? '' : 's'}:`);
  for (const item of report.issues) {
   const where = item.page ? `page ${item.page}${item.row ? `, row ${item.row}` : ''}: ` : '';
   lines.push(`- ${item.severity === 'serious' ? '✗' : '!'} ${where}${item.message}`);
  }
 }
 if (report.editedAmounts?.length) {
  lines.push('', `Edited amounts (${report.editedAmounts.length} row${report.editedAmounts.length === 1 ? '' : 's'}; the balances follow these):`);
  for (const item of report.editedAmounts.slice(0, 10)) lines.push(`- page ${item.page}, row ${item.row}: ${item.from} → ${item.to}`);
  if (report.editedAmounts.length > 10) lines.push(`- … ${report.editedAmounts.length - 10} more`);
 }
 if (report.fixes.length) {
  lines.push('', 'Balance fixes (follow the amounts already in the document):');
  for (const fix of report.fixes.slice(0, 20)) lines.push(`- page ${fix.page}, row ${fix.row}: ${fix.from} → ${fix.to}`);
  if (report.fixes.length > 20) lines.push(`- … ${report.fixes.length - 20} more`);
 }
 return lines.join('\n');
}
