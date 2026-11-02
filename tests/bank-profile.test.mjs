import test from 'node:test';
import assert from 'node:assert/strict';
import {
 BANK_PROFILES, PROFILE_ORDER, DEFAULT_ALIGNMENT, profileScore, detectBankProfile,
 resolveProfile, profileOptions, splitDirection, hasDirectionSuffix,
} from '../dist/bank-profile.mjs';
import {columnAlignment} from '../dist/native-export.mjs';

// The text a State Bank statement carries, taken from the reported file.
const SBI_TEXT = 'Statement of Account Statement Summary : 01-04-2026 To 02-11-2026 ' +
 'Brought Forward Dr Count Cr Count Total Debits Total Credits Closing Balance ' +
 '17.66CR 269 33 2,86,413.23 2,86,410.00 14.43CR';
// The bracketed style the union-bank statements that shaped the editor use.
const UNION_TEXT = 'Union Bank of India Statement of Account Withdrawal Deposit Balance ' +
 '100.00(Dr) 500.00(Cr) 12.00 (Dr)';

test('a statement is named from its own text, and nothing else is guessed', () => {
 assert.equal(detectBankProfile(SBI_TEXT), 'sbi');
 assert.equal(detectBankProfile(UNION_TEXT), 'union');
 assert.equal(detectBankProfile('Invoice 100.00 50.00 total'), 'generic');
 assert.equal(detectBankProfile(''), 'generic');
 // One shared line (every statement has a statement of account line) is not
 // enough to apply one bank's column rules to another bank's paper.
 assert.equal(detectBankProfile('Statement of Account'), 'generic');
 assert.ok(profileScore('sbi', SBI_TEXT) > profileScore('union', SBI_TEXT));
 assert.ok(profileScore('union', UNION_TEXT) > profileScore('sbi', UNION_TEXT));
});

test('a layout is chosen per document and the manual choice wins', () => {
 assert.equal(resolveProfile('auto', 'sbi').id, 'sbi');
 assert.equal(resolveProfile('auto', 'union').id, 'union');
 assert.equal(resolveProfile('auto', 'generic').id, 'generic');
 assert.equal(resolveProfile('union', 'sbi').id, 'union', 'a chosen layout is not overridden by detection');
 assert.equal(resolveProfile('sbi', 'generic').id, 'sbi');
 assert.equal(resolveProfile('', 'sbi').id, 'sbi');
 assert.equal(resolveProfile('nonsense', 'union').id, 'union');
 assert.equal(resolveProfile('auto', 'nonsense').id, 'generic');
 for (const id of PROFILE_ORDER) assert.ok(BANK_PROFILES[id], `${id} is a profile`);
 assert.equal(profileOptions().length, PROFILE_ORDER.length);
 assert.deepEqual(BANK_PROFILES.union.alignment, DEFAULT_ALIGNMENT, 'the union tuning is unchanged');
});

test('the bank profiles keep their own column rules', () => {
 assert.equal(BANK_PROFILES.union.align, 'right');
 assert.equal(BANK_PROFILES.union.directionSuffix, false);
 assert.equal(BANK_PROFILES.sbi.align, 'decimal');
 assert.equal(BANK_PROFILES.sbi.directionSuffix, true);
 assert.equal(BANK_PROFILES.generic.align, 'right');
});

test('the figure is separated from the direction printed after it', () => {
 assert.deepEqual(splitDirection('14.43CR'), {number: '14.43', suffix: 'CR'});
 assert.deepEqual(splitDirection('17.66 Cr'), {number: '17.66', suffix: ' Cr'});
 assert.deepEqual(splitDirection('100.00(Dr)'), {number: '100.00', suffix: '(Dr)'});
 assert.deepEqual(splitDirection('2,86,410.00'), {number: '2,86,410.00', suffix: ''});
 assert.deepEqual(splitDirection('318.66'), {number: '318.66', suffix: ''});
 assert.deepEqual(splitDirection('NEFT/CR/1234'), {number: 'NEFT/CR/1234', suffix: ''}, 'a narration keeps its word');
 assert.equal(hasDirectionSuffix('14.43CR'), true);
 assert.equal(hasDirectionSuffix('14.43'), false);
});

// A column of amounts as the printer drew them: the figure right-aligned with a
// fixed-width metric, the direction sometimes written straight after it.
const CHAR = 3.56;
// What the writer measures when it places a value: the figure alone in decimal
// mode, the whole run otherwise.
const figureWidth = text => splitDirection(text).number.length * CHAR;
const runWidth = text => text.length * CHAR;
const row = (text, {right = 545.6, page = 1, y = 0}) => ({
 id: `${page}:${text}:${y}`, page, text, x: right - text.length * CHAR, y, width: text.length * CHAR,
 size: 9, color: '#000000',
});

test('the SBI layout aligns a column on the figure, not on its direction suffix', () => {
 // Four plain balances on one edge, two more carrying the direction run straight
 // after the figure: the printer right-aligns the run, so its figure stops short.
 const plain = ['318.66', '308.66', '295.66', '288.66'].map((text, index) => row(text, {y: 100 + index * 20}));
 const suffixed = ['4,281.66CR', '4,283.66CR'].map((text, index) => row(text, {y: 200 + index * 20}));
 const rows = [...plain, ...suffixed];

 const landed = mode => {
  const moves = columnAlignment(rows, {...BANK_PROFILES.sbi.alignment, mode});
  const applied = new Map(moves.map(move => [move.block.id, move]));
  return {moves, entries: rows.map(block => {
   const move = applied.get(block.id);
   const width = move?.numberEdge ? figureWidth(block.text) : runWidth(block.text);
   const x = move ? move.edge - width : block.x;
   return {text: block.text, figureRight: x + figureWidth(block.text)};
  })};
 };

 const decimal = landed('decimal');
 // Every figure ends on the column, whatever its width or its suffix.
 for (const entry of decimal.entries) assert.ok(Math.abs(entry.figureRight - 545.6) < 0.05,
  `${entry.text} figure ends on the column, it ended at ${entry.figureRight}`);
 assert.deepEqual(decimal.moves.map(move => move.block.text), ['4,281.66CR', '4,283.66CR']);
 for (const move of decimal.moves) assert.equal(move.numberEdge, true);

 // Read as whole runs the same cells look aligned and are left alone, with their
 // figures 7.12pt short of the column: the misalignment being fixed.
 const right = landed('right');
 const short = right.entries.filter(entry => entry.text.endsWith('CR'));
 assert.equal(right.moves.length, 0);
 for (const entry of short) assert.ok(Math.abs(entry.figureRight - (545.6 - 7.12)) < 0.05,
  `${entry.text} would sit ${545.6 - entry.figureRight}pt off the column`);
});
